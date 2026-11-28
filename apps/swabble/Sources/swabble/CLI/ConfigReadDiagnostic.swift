import Foundation
import Swabble

func configReadDiagnostic(_ error: any Error) -> String {
    if case ConfigError.missingConfig = error {
        return "file not found. Check the path."
    }
    if error is DecodingError {
        return "invalid or incompatible JSON. Check the syntax and fields."
    }
    return "could not read the file. Check the path and permissions."
}
