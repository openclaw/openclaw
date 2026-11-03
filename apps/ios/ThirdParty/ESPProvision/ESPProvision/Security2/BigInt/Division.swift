// Copyright (c) 2016-2017 Károly Lőrentey
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of
// this software and associated documentation files (the "Software"), to deal in
// the Software without restriction, including without limitation the rights to
// use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
// of the Software, and to permit persons to whom the Software is furnished to do
// so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
//
//  Division.swift
//  BigInt
//
//  Created by Károly Lőrentey on 2016-01-03.
//  Copyright © 2016-2017 Károly Lőrentey.
//

//MARK: Full-width multiplication and division

// TODO: Return to `where Magnitude == Self` when SR-13491 is resolved
extension FixedWidthInteger {
    private var halfShift: Self {
        return Self(Self.bitWidth / 2)

    }
    private var high: Self {
        return self &>> halfShift
    }

    private var low: Self {
        let mask: Self = 1 &<< halfShift - 1
        return self & mask
    }

    private var upshifted: Self {
        return self &<< halfShift
    }

    private var split: (high: Self, low: Self) {
        return (self.high, self.low)
    }

    private init(_ value: (high: Self, low: Self)) {
        self = value.high.upshifted + value.low
    }

    /// Divide the double-width integer `dividend` by `self` and return the quotient and remainder.
    ///
    /// - Requires: `dividend.high < self`, so that the result will fit in a single digit.
    /// - Complexity: O(1) with 2 divisions, 6 multiplications and ~12 or so additions/subtractions.
    internal func fastDividingFullWidth(_ dividend: (high: Self, low: Self.Magnitude)) -> (quotient: Self, remainder: Self) {
        // Division is complicated; doing it with single-digit operations is maddeningly complicated.
        // This is a Swift adaptation for "divlu2" in Hacker's Delight,
        // which is in turn a C adaptation of Knuth's Algorithm D (TAOCP vol 2, 4.3.1).
        precondition(dividend.high < self)

        // This replaces the implementation in stdlib, which is much slower.
        // FIXME: Speed up stdlib. It should use full-width idiv on Intel processors, and
        // fall back to a reasonably fast algorithm elsewhere.

        // The trick here is that we're actually implementing a 4/2 long division using half-words,
        // with the long division loop unrolled into two 3/2 half-word divisions.
        // Luckily, 3/2 half-word division can be approximated by a single full-word division operation
        // that, when the divisor is normalized, differs from the correct result by at most 2.

        /// Find the half-word quotient in `u / vn`, which must be normalized.
        /// `u` contains three half-words in the two halves of `u.high` and the lower half of
        /// `u.low`. (The weird distribution makes for a slightly better fit with the input.)
        /// `vn` contains the normalized divisor, consisting of two half-words.
        ///
        /// - Requires: u.high < vn && u.low.high == 0 && vn.leadingZeroBitCount == 0
        func quotient(dividing u: (high: Self, low: Self), by vn: Self) -> Self {
            let (vn1, vn0) = vn.split
            // Get approximate quotient.
            let (q, r) = u.high.quotientAndRemainder(dividingBy: vn1)
            let p = q * vn0
            // q is often already correct, but sometimes the approximation overshoots by at most 2.
            // The code that follows checks for this while being careful to only perform single-digit operations.
            if q.high == 0 && p <= r.upshifted + u.low { return q }
            let r2 = r + vn1
            if r2.high != 0 { return q - 1 }
            if (q - 1).high == 0 && p - vn0 <= r2.upshifted + u.low { return q - 1 }
            //assert((r + 2 * vn1).high != 0 || p - 2 * vn0 <= (r + 2 * vn1).upshifted + u.low)
            return q - 2
        }
        /// Divide 3 half-digits by 2 half-digits to get a half-digit quotient and a full-digit remainder.
        ///
        /// - Requires: u.high < v && u.low.high == 0 && vn.width = width(Digit)
        func quotientAndRemainder(dividing u: (high: Self, low: Self), by v: Self) -> (quotient: Self, remainder: Self) {
            let q = quotient(dividing: u, by: v)
            // Note that `uh.low` masks off a couple of bits, and `q * v` and the
            // subtraction are likely to overflow. Despite this, the end result (remainder) will
            // still be correct and it will fit inside a single (full) Digit.
            let r = Self(u) &- q &* v
            assert(r < v)
            return (q, r)
        }

        // Normalize the dividend and the divisor (self) such that the divisor has no leading zeroes.
        let z = Self(self.leadingZeroBitCount)
        let w = Self(Self.bitWidth) - z
        let vn = self << z

        let un32 = (z == 0 ? dividend.high : (dividend.high &<< z) | ((dividend.low as! Self) &>> w)) // No bits are lost
        let un10 = dividend.low &<< z
        let (un1, un0) = un10.split

        // Divide `(un32,un10)` by `vn`, splitting the full 4/2 division into two 3/2 ones.
        let (q1, un21) = quotientAndRemainder(dividing: (un32, (un1 as! Self)), by: vn)
        let (q0, rn) = quotientAndRemainder(dividing: (un21, (un0 as! Self)), by: vn)

        // Undo normalization of the remainder and combine the two halves of the quotient.
        let mod = rn >> z
        let div = Self((q1, q0))
        return (div, mod)
    }

    /// Return the quotient of the 3/2-word division `x/y` as a single word.
    ///
    /// - Requires: (x.0, x.1) <= y && y.0.high != 0
    /// - Returns: The exact value when it fits in a single word, otherwise `Self`.
    static func approximateQuotient(dividing x: (Self, Self, Self), by y: (Self, Self)) -> Self {
        // Start with q = (x.0, x.1) / y.0, (or Word.max on overflow)
        var q: Self
        var r: Self
        if x.0 == y.0 {
            q = Self.max
            let (s, o) = x.0.addingReportingOverflow(x.1)
            if o { return q }
            r = s
        }
        else {
            (q, r) = y.0.fastDividingFullWidth((x.0, (x.1 as! Magnitude)))
        }
        // Now refine q by considering x.2 and y.1.
        // Note that since y is normalized, q * y - x is between 0 and 2.
        let (ph, pl) = q.multipliedFullWidth(by: y.1)
        if ph < r || (ph == r && pl <= x.2) { return q }

        let (r1, ro) = r.addingReportingOverflow(y.0)
        if ro { return q - 1 }

        let (pl1, so) = pl.subtractingReportingOverflow((y.1 as! Magnitude))
        let ph1 = (so ? ph - 1 : ph)

        if ph1 < r1 || (ph1 == r1 && pl1 <= x.2) { return q - 1 }
        return q - 2
    }
}

extension BigUInt {
    //MARK: Division

    /// Divide this integer by the word `y`, leaving the quotient in its place and returning the remainder.
    ///
    /// - Requires: y > 0
    /// - Complexity: O(count)
    internal mutating func divide(byWord y: Word) -> Word {
        precondition(y > 0)
        if y == 1 { return 0 }
        
        var remainder: Word = 0
        for i in (0 ..< count).reversed() {
            let u = self[i]
            (self[i], remainder) = y.fastDividingFullWidth((remainder, u))
        }
        return remainder
    }

    /// Divide this integer by the word `y` and return the resulting quotient and remainder.
    ///
    /// - Requires: y > 0
    /// - Returns: (quotient, remainder) where quotient = floor(x/y), remainder = x - quotient * y
    /// - Complexity: O(x.count)
    internal func quotientAndRemainder(dividingByWord y: Word) -> (quotient: BigUInt, remainder: Word) {
        var div = self
        let mod = div.divide(byWord: y)
        return (div, mod)
    }

    /// Divide `x` by `y`, putting the quotient in `x` and the remainder in `y`.
    /// Reusing integers like this reduces the number of allocations during the calculation.
    static func divide(_ x: inout BigUInt, by y: inout BigUInt) {
        // This is a Swift adaptation of "divmnu" from Hacker's Delight, which is in
        // turn a C adaptation of Knuth's Algorithm D (TAOCP vol 2, 4.3.1).

        precondition(!y.isZero)

        // First, let's take care of the easy cases.
        if x < y {
            (x, y) = (0, x)
            return
        }
        if y.count == 1 {
            // The single-word case reduces to a simpler loop.
            y = BigUInt(x.divide(byWord: y[0]))
            return
        }

        // In the hard cases, we will perform the long division algorithm we learned in school.
        // It works by successively calculating the single-word quotient of the top y.count + 1
        // words of x divided by y, replacing the top of x with the remainder, and repeating
        // the process one word lower.
        //
        // The tricky part is that the algorithm needs to be able to do n+1/n word divisions,
        // but we only have a primitive for dividing two words by a single
        // word. (Remember that this step is also tricky when we do it on paper!)
        //
        // The solution is that the long division can be approximated by a single full division
        // using just the most significant words. We can then use multiplications and
        // subtractions to refine the approximation until we get the correct quotient word.
        //
        // We could do this by doing a simple 2/1 full division, but Knuth goes one step further,
        // and implements a 3/2 division. This results in an exact approximation in the
        // vast majority of cases, eliminating an extra subtraction over big integers.
        //
        // The function `approximateQuotient` above implements Knuth's 3/2 division algorithm.
        // It requires that the divisor's most significant word is larger than
        // Word.max / 2. This ensures that the approximation has tiny error bounds,
        // which is what makes this entire approach viable.
        // To satisfy this requirement, we will normalize the division by multiplying
        // both the divisor and the dividend by the same (small) factor.
        let z = y.leadingZeroBitCount
        y <<= z
        x <<= z // We'll calculate the remainder in the normalized dividend.
        var quotient = BigUInt()
        assert(y.leadingZeroBitCount == 0)

        // We're ready to start the long division!
        let dc = y.count
        let d1 = y[dc - 1]
        let d0 = y[dc - 2]
        var product: BigUInt = 0
        for j in (dc ... x.count).reversed() {
            // Approximate dividing the top dc+1 words of `remainder` using the topmost 3/2 words.
            let r2 = x[j]
            let r1 = x[j - 1]
            let r0 = x[j - 2]
            let q = Word.approximateQuotient(dividing: (r2, r1, r0), by: (d1, d0))

            // Multiply the entire divisor with `q` and subtract the result from remainder.
            // Normalization ensures the 3/2 quotient will either be exact for the full division, or
            // it may overshoot by at most 1, in which case the product will be greater
            // than the remainder.
            product.load(y)
            product.multiply(byWord: q)
            if product <= x.extract(j - dc ..< j + 1) {
                x.subtract(product, shiftedBy: j - dc)
                quotient[j - dc] = q
            }
            else {
                // This case is extremely rare -- it has a probability of 1/2^(Word.bitWidth - 1).
                x.add(y, shiftedBy: j - dc)
                x.subtract(product, shiftedBy: j - dc)
                quotient[j - dc] = q - 1
            }
        }
        // The remainder's normalization needs to be undone, but otherwise we're done.
        x >>= z
        y = x
        x = quotient
    }

    /// Divide `x` by `y`, putting the remainder in `x`.
    mutating func formRemainder(dividingBy y: BigUInt, normalizedBy shift: Int) {
        precondition(!y.isZero)
        assert(y.leadingZeroBitCount == 0)
        if y.count == 1 {
            let remainder = self.divide(byWord: y[0] >> shift)
            self.load(BigUInt(remainder))
            return
        }
        self <<= shift
        if self >= y {
            let dc = y.count
            let d1 = y[dc - 1]
            let d0 = y[dc - 2]
            var product: BigUInt = 0
            for j in (dc ... self.count).reversed() {
                let r2 = self[j]
                let r1 = self[j - 1]
                let r0 = self[j - 2]
                let q = Word.approximateQuotient(dividing: (r2, r1, r0), by: (d1, d0))
                product.load(y)
                product.multiply(byWord: q)
                if product <= self.extract(j - dc ..< j + 1) {
                    self.subtract(product, shiftedBy: j - dc)
                }
                else {
                    self.add(y, shiftedBy: j - dc)
                    self.subtract(product, shiftedBy: j - dc)
                }
            }
        }
        self >>= shift
    }


    /// Divide this integer by `y` and return the resulting quotient and remainder.
    ///
    /// - Requires: `y > 0`
    /// - Returns: `(quotient, remainder)` where `quotient = floor(self/y)`, `remainder = self - quotient * y`
    /// - Complexity: O(count^2)
    public func quotientAndRemainder(dividingBy y: BigUInt) -> (quotient: BigUInt, remainder: BigUInt) {
        var x = self
        var y = y
        BigUInt.divide(&x, by: &y)
        return (x, y)
    }

    /// Divide `x` by `y` and return the quotient.
    ///
    /// - Note: Use `divided(by:)` if you also need the remainder.
    public static func /(x: BigUInt, y: BigUInt) -> BigUInt {
        return x.quotientAndRemainder(dividingBy: y).quotient
    }

    /// Divide `x` by `y` and return the remainder.
    ///
    /// - Note: Use `divided(by:)` if you also need the remainder.
    public static func %(x: BigUInt, y: BigUInt) -> BigUInt {
        var x = x
        let shift = y.leadingZeroBitCount
        x.formRemainder(dividingBy: y << shift, normalizedBy: shift)
        return x
    }

    /// Divide `x` by `y` and store the quotient in `x`.
    ///
    /// - Note: Use `divided(by:)` if you also need the remainder.
    public static func /=(x: inout BigUInt, y: BigUInt) {
        var y = y
        BigUInt.divide(&x, by: &y)
    }

    /// Divide `x` by `y` and store the remainder in `x`.
    ///
    /// - Note: Use `divided(by:)` if you also need the remainder.
    public static func %=(x: inout BigUInt, y: BigUInt) {
        let shift = y.leadingZeroBitCount
        x.formRemainder(dividingBy: y << shift, normalizedBy: shift)
    }
}
