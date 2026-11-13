// Copyright 2020 Espressif Systems
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
//  ESPLogging.swift
//  ESPProvision
//

import Foundation

/// Type that manages printing of formatted console logs for debugging process.
class ESPLog {
    
    /// Boolean to determine whether console log needs to be printed
    static var isLogEnabled = false
    
    /// Prints messages in console that are triggered from different functions in a workflow.
    /// Add additional info like timestamp, filename, function name and line before printing the output.
    ///
    /// - Parameters:
    ///   - message: Message describing the current instruction in a workflow.
    ///   - file: Filename containing the caller of this function.
    ///   - function: Name of the function invoking this method.
    ///   - line: Line number from where the logs are generated.
    static func log(_ message: String, file:String = #file, function:String = #function, line:Int = #line) {
        
        if isLogEnabled {
            var filename = (file as NSString).lastPathComponent
            filename = filename.components(separatedBy: ".")[0]

            let currentDate = Date()
            let df = DateFormatter()
            df.dateFormat = "HH:mm:ss.SSS"
            
            print("\(df.string(from: currentDate)) | \(filename).\(function) (\(line)) : \(message)")
        }
    }
}
