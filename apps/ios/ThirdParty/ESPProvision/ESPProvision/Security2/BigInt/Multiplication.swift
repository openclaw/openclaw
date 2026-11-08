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
//  Multiplication.swift
//  BigInt
//
//  Created by Károly Lőrentey on 2016-01-03.
//  Copyright © 2016-2017 Károly Lőrentey.
//

extension BigUInt {

    //MARK: Multiplication

    /// Multiply this big integer by a single word, and store the result in place of the original big integer.
    ///
    /// - Complexity: O(count)
    public mutating func multiply(byWord y: Word) {
        guard y != 0 else { self = 0; return }
        guard y != 1 else { return }
        var carry: Word = 0
        let c = self.count
        for i in 0 ..< c {
            let (h, l) = self[i].multipliedFullWidth(by: y)
            let (low, o) = l.addingReportingOverflow(carry)
            self[i] = low
            carry = (o ? h + 1 : h)
        }
        self[c] = carry
    }

    /// Multiply this big integer by a single Word, and return the result.
    ///
    /// - Complexity: O(count)
    public func multiplied(byWord y: Word) -> BigUInt {
        var r = self
        r.multiply(byWord: y)
        return r
    }

    /// Multiply `x` by `y`, and add the result to this integer, optionally shifted `shift` words to the left.
    ///
    /// - Note: This is the fused multiply/shift/add operation; it is more efficient than doing the components
    ///   individually. (The fused operation doesn't need to allocate space for temporary big integers.)
    /// - Returns: `self` is set to `self + (x * y) << (shift * 2^Word.bitWidth)`
    /// - Complexity: O(count)
    public mutating func multiplyAndAdd(_ x: BigUInt, _ y: Word, shiftedBy shift: Int = 0) {
        precondition(shift >= 0)
        guard y != 0 && x.count > 0 else { return }
        guard y != 1 else { self.add(x, shiftedBy: shift); return }
        var mulCarry: Word = 0
        var addCarry = false
        let xc = x.count
        var xi = 0
        while xi < xc || addCarry || mulCarry > 0 {
            let (h, l) = x[xi].multipliedFullWidth(by: y)
            let (low, o) = l.addingReportingOverflow(mulCarry)
            mulCarry = (o ? h + 1 : h)

            let ai = shift + xi
            let (sum1, so1) = self[ai].addingReportingOverflow(low)
            if addCarry {
                let (sum2, so2) = sum1.addingReportingOverflow(1)
                self[ai] = sum2
                addCarry = so1 || so2
            }
            else {
                self[ai] = sum1
                addCarry = so1
            }
            xi += 1
        }
    }

    /// Multiply this integer by `y` and return the result.
    ///
    /// - Note: This uses the naive O(n^2) multiplication algorithm unless both arguments have more than
    ///   `BigUInt.directMultiplicationLimit` words.
    /// - Complexity: O(n^log2(3))
    public func multiplied(by y: BigUInt) -> BigUInt {
        // This method is mostly defined for symmetry with the rest of the arithmetic operations.
        return self * y
    }

    /// Multiplication switches to an asymptotically better recursive algorithm when arguments have more words than this limit.
    public static var directMultiplicationLimit: Int = 1024

    /// Multiply `a` by `b` and return the result.
    ///
    /// - Note: This uses the naive O(n^2) multiplication algorithm unless both arguments have more than
    ///   `BigUInt.directMultiplicationLimit` words.
    /// - Complexity: O(n^log2(3))
    public static func *(x: BigUInt, y: BigUInt) -> BigUInt {
        let xc = x.count
        let yc = y.count
        if xc == 0 { return BigUInt() }
        if yc == 0 { return BigUInt() }
        if yc == 1 { return x.multiplied(byWord: y[0]) }
        if xc == 1 { return y.multiplied(byWord: x[0]) }

        if Swift.min(xc, yc) <= BigUInt.directMultiplicationLimit {
            // Long multiplication.
            let left = (xc < yc ? y : x)
            let right = (xc < yc ? x : y)
            var result = BigUInt()
            for i in (0 ..< right.count).reversed() {
                result.multiplyAndAdd(left, right[i], shiftedBy: i)
            }
            return result
        }

        if yc < xc {
            let (xh, xl) = x.split
            var r = xl * y
            r.add(xh * y, shiftedBy: x.middleIndex)
            return r
        }
        else if xc < yc {
            let (yh, yl) = y.split
            var r = yl * x
            r.add(yh * x, shiftedBy: y.middleIndex)
            return r
        }

        let shift = x.middleIndex

        // Karatsuba multiplication:
        // x * y = <a,b> * <c,d> = <ac, ac + bd - (a-b)(c-d), bd> (ignoring carry)
        let (a, b) = x.split
        let (c, d) = y.split

        let high = a * c
        let low = b * d
        let xp = a >= b
        let yp = c >= d
        let xm = (xp ? a - b : b - a)
        let ym = (yp ? c - d : d - c)
        let m = xm * ym

        var r = low
        r.add(high, shiftedBy: 2 * shift)
        r.add(low, shiftedBy: shift)
        r.add(high, shiftedBy: shift)
        if xp == yp {
            r.subtract(m, shiftedBy: shift)
        }
        else {
            r.add(m, shiftedBy: shift)
        }
        return r
    }

    /// Multiply `a` by `b` and store the result in `a`.
    public static func *=(a: inout BigUInt, b: BigUInt) {
        a = a * b
    }
}
