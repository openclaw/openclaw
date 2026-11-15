// Copyright (C) 2016 Bouke Haarsma
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


import Foundation

/// Possible authentication failure modes.
public enum AuthenticationFailure: Error {
    /// Security breach: the provided public key is empty (i.e. PK % N is zero).
    case invalidPublicKey

    /// Invalid client state: call `processChallenge` before `verifySession`.
    case missingChallenge

    /// Failed authentication: the key proof didn't match our own.
    case keyProofMismatch
}

extension AuthenticationFailure: CustomStringConvertible {
    /// A textual representation of this instance.
    ///
    /// Instead of accessing this property directly, convert an instance of any
    /// type to a string by using the `String(describing:)` initializer.
    public var description: String {
        switch self {
        case .invalidPublicKey: return "security breach - the provided public key is invalid"
        case .missingChallenge: return "invalid client state - call `processChallenge` before `verifySession`"
        case .keyProofMismatch: return "failed authentication - the key proof didn't match our own"
        }
    }
}
