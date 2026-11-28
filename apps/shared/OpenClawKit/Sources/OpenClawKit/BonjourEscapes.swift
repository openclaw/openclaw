import Foundation

public enum BonjourEscapes {
    /// mDNS / DNS-SD commonly escapes bytes in instance names as `\DDD` (decimal-encoded),
    /// e.g. spaces are `\032`. Escapes are octets, so a multi-byte UTF-8 character arrives
    /// as several escapes; collect bytes and decode them as UTF-8, like the Android decoder.
    public static func decode(_ input: String) -> String {
        var bytes: [UInt8] = []
        var i = input.startIndex
        while i < input.endIndex {
            if input[i] == "\\" {
                let digits = input[input.index(after: i)...].prefix(3)
                if digits.count == 3, digits.allSatisfy({ $0.isASCII && $0.isNumber }),
                   let value = UInt8(digits)
                {
                    bytes.append(value)
                    i = input.index(i, offsetBy: 4)
                    continue
                }
            }

            bytes.append(contentsOf: String(input[i]).utf8)
            i = input.index(after: i)
        }
        return String(decoding: bytes, as: UTF8.self)
    }
}
