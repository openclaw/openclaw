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
//  Exponentiation.swift
//  BigInt
//
//  Created by Károly Lőrentey on 2016-01-03.
//  Copyright © 2016-2017 Károly Lőrentey.
//

extension BigUInt {
    //MARK: Exponentiation

    /// Returns this integer raised to the power `exponent`.
    ///
    /// This function calculates the result by [successively squaring the base while halving the exponent][expsqr].
    ///
    /// [expsqr]: https://en.wikipedia.org/wiki/Exponentiation_by_squaring
    ///
    /// - Note: This function can be unreasonably expensive for large exponents, which is why `exponent` is
    ///         a simple integer value. If you want to calculate big exponents, you'll probably need to use
    ///         the modulo arithmetic variant.
    /// - Returns: 1 if `exponent == 0`, otherwise `self` raised to `exponent`. (This implies that `0.power(0) == 1`.)
    /// - SeeAlso: `BigUInt.power(_:, modulus:)`
    /// - Complexity: O((exponent * self.count)^log2(3)) or somesuch. The result may require a large amount of memory, too.
    public func power(_ exponent: Int) -> BigUInt {
        if exponent == 0 { return 1 }
        if exponent == 1 { return self }
        if exponent < 0 {
            precondition(!self.isZero)
            return self == 1 ? 1 : 0
        }
        if self <= 1 { return self }
        var result = BigUInt(1)
        var b = self
        var e = exponent
        while e > 0 {
            if e & 1 == 1 {
                result *= b
            }
            e >>= 1
            b *= b
        }
        return result
    }

    /// Returns the remainder of this integer raised to the power `exponent` in modulo arithmetic under `modulus`.
    ///
    /// Uses the [right-to-left binary method][rtlb].
    ///
    /// [rtlb]: https://en.wikipedia.org/wiki/Modular_exponentiation#Right-to-left_binary_method
    ///
    /// - Complexity: O(exponent.count * modulus.count^log2(3)) or somesuch
    public func power(_ exponent: BigUInt, modulus: BigUInt) -> BigUInt {
        precondition(!modulus.isZero)
        if modulus == (1 as BigUInt) { return 0 }
        let shift = modulus.leadingZeroBitCount
        let normalizedModulus = modulus << shift
        var result = BigUInt(1)
        var b = self
        b.formRemainder(dividingBy: normalizedModulus, normalizedBy: shift)
        for var e in exponent.words {
            for _ in 0 ..< Word.bitWidth {
                if e & 1 == 1 {
                    result *= b
                    result.formRemainder(dividingBy: normalizedModulus, normalizedBy: shift)
                }
                e >>= 1
                b *= b
                b.formRemainder(dividingBy: normalizedModulus, normalizedBy: shift)
            }
        }
        return result
    }
}
