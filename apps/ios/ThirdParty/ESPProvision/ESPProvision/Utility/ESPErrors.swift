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
//  ESPErrors.swift
//  ESPProvision
//

import Foundation

/// Error types returned by ESPProvision conforms to 'ESPError' protocol. It encompasses additional information
/// which may be used for gaining additional information about an error.
public protocol ESPError: Error {
    /// Returns description of an error
    var description: String { get }
    /// Returns unique code associated with an error
    var code: Int { get }
}

/// 'ESPWifiScanError' consist of error cases that will be generated in the process of fetching available Wi-FI
/// network list from an ESPDevice,
public enum ESPWiFiScanError: ESPError {

    /// Unable to generate Wi-Fi scan request configuration data.
    case emptyConfigData
    /// Scan result returned from ESPDevice contains no Wi-Fi networks.
    case emptyResultCount
    /// Consist of errors generated during sending, recieving and parsing of request/response related with Wi-Fi scan.
    case scanRequestError(Error)
    
    public var description: String {
        switch self {
        case .emptyConfigData:
            return "Configuration data to request Wi-Fi list is empty."
        case .emptyResultCount:
            return "Number of Wi-Fi network scanned result is nil"
        case .scanRequestError(let error):
            return "Request for returning Wi-Fi network list failed with error: \(error.localizedDescription)"
        }
    }
    
    public var code:Int {
        switch self {
        case .emptyConfigData:
            return 1
        case .emptyResultCount:
            return 2
        case .scanRequestError(_):
            return 3
        }
    }
}

/// 'ESPThreadScanError' consist of error cases that will be generated in the process of fetching available Thread
/// network list from an ESPDevice,
public enum ESPThreadScanError: ESPError {

    /// Unable to generate Thread scan request configuration data.
    case emptyConfigData
    /// Scan result returned from ESPDevice contains no Thread networks.
    case emptyResultCount
    /// Consist of errors generated during sending, recieving and parsing of request/response related with Thread scan.
    case scanRequestError(Error)
    
    public var description: String {
        switch self {
        case .emptyConfigData:
            return "Configuration data to request Thread list is empty."
        case .emptyResultCount:
            return "Number of Thread network scanned result is nil"
        case .scanRequestError(let error):
            return "Request for returning Wi-Fi network list failed with error: \(error.localizedDescription)"
        }
    }
    
    public var code:Int {
        switch self {
        case .emptyConfigData:
            return 1
        case .emptyResultCount:
            return 2
        case .scanRequestError(_):
            return 3
        }
    }
}

/// 'ESPSessionError' covers error cases that are generated throughout the life cycle of ESPDevice session
/// right from the beginning of session establishment till termination.
public enum ESPSessionError: ESPError {
    
    /// Failed to initialise session.
    case sessionInitError
    /// Session is not established with ESPDevice.
    case sessionNotEstablished
    /// The attempt to send data to ESPDevice failed with underlying system error.
    case sendDataError(Error)
    /// The attempt to join SoftAP network of ESPDevice failed.
    case softAPConnectionFailure
    /// Security configuration for communication between ESPDevice and app does not match.
    case securityMismatch
    /// The attempt to get version information from ESPDevice failed with underlying error.
    case versionInfoError(Error)
    /// The attempt to connect with ESPDevice of bluetooth capability failed.
    case bleFailedToConnect
    /// Encryption error
    case encryptionError
    /// Proof of possession is not present
    case noPOP
    /// Username is not present
    case noUsername
    
    public var description: String {
        switch self {
        case .sessionInitError:
            return "Failed to initialise session with the device"
        case .sessionNotEstablished:
            return "Session not established with the device"
        case .sendDataError(let error):
            return "Request to send data to device failed with error: \(error.localizedDescription)"
        case .softAPConnectionFailure:
            return "Failed to connect device SoftAp network"
        case .securityMismatch:
            return "Security applied for communicating with device does not match configuration setting"
        case .versionInfoError(let error):
            return "Failed to get device version information with error: \(error.localizedDescription)"
        case .bleFailedToConnect:
            return "Failed to connect with BLE device"
        case .encryptionError:
            return "Unable to encrypt data"
        case .noPOP:
            return "Proof of possession is not present."
        case .noUsername:
            return "Username is not present."
        }
    }
    
    public var code: Int {
        switch self {
        case .sessionInitError:
            return 11
        case .sessionNotEstablished:
            return 12
        case .sendDataError(_):
            return 13
        case .softAPConnectionFailure:
            return 14
        case .securityMismatch:
            return 15
        case .versionInfoError:
            return 16
        case .bleFailedToConnect:
            return 17
        case .encryptionError:
            return 18
        case .noPOP:
            return 19
        case .noUsername:
            return 20
        }
    }
}

/// 'ESPDeviceCSSError' consist of error case that are generated while creating objects of physical ESPDevice.
/// List covers failed cases of operation like Create, Scan and Search of ESPDevice.
public enum ESPDeviceCSSError: ESPError {
    
    /// Indicates camera is not available in device.
    case cameraNotAvailable
    /// Camera access is denied by user.
    case cameraAccessDenied
    /// Unable to process camera input stream.
    case avCaptureDeviceInputError
    /// Failed to get Video input.
    case videoInputError
    /// AVCaptureOutput instance can not be added to session.
    case videoOutputError
    /// QR code has some missing parameters or unsupported type. Please refer to RainMaker docs for more details.
    case invalidQRCode(String)
    /// No ESPDevice is found on search.
    case espDeviceNotFound
    /// SoftAp ESPDeivce search is not currently supported in iOS.
    case softApSearchNotSupported
    
    public var description: String {
        switch self {
        case .cameraNotAvailable:
            return "Camera is not available in this device to scan code"
        case .cameraAccessDenied:
            return "Permission to access camera is denied"
        case .avCaptureDeviceInputError:
            return "Error while capturing input from camera"
        case .videoInputError:
            return "Error while taking video input from camera"
        case .videoOutputError:
            return "Error while processing video output from camera"
        case .invalidQRCode:
            return "Scanned QR code is invalid."
        case .espDeviceNotFound:
            return "No bluetooth device found with given prefix"
        case .softApSearchNotSupported:
            return "SoftAp device search is not currently supported in iOS"
        }
    }
    
    public var code: Int {
        switch self {
        case .cameraNotAvailable:
            return 21
        case .cameraAccessDenied:
            return 22
        case .avCaptureDeviceInputError:
            return 23
        case .videoInputError:
            return 24
        case .videoOutputError:
            return 25
        case .invalidQRCode:
            return 26
        case .espDeviceNotFound:
            return 27
        case .softApSearchNotSupported:
            return 28
        }
    }
}

/// 'ESPProvsionError' covers reason for failed cases that occurs while provisioning of ESPDevice.
public enum ESPProvisionError: ESPError {
    
    /// Session needed for communication is not maintained with ESPDevice.
    case sessionError
    /// The attempt to apply network configuration in ESPDevice failed with associated error.
    case configurationError(Error)
    /// The attempt to fetch Wi-Fi status of ESPDevice failed with underlying error.
    case wifiStatusError(Error)
    /// Unable to apply Wi-Fi settings to ESPDevice with status disconnected.
    case wifiStatusDisconnected
    /// Wrong Wi-Fi credentials applied to ESPDevice.
    case wifiStatusAuthenticationError
    /// Wi-Fi network not found.
    case wifiStatusNetworkNotFound
    /// Wi-Fi status of ESPDevice is unknown.
    case wifiStatusUnknownError
    /// The attempt to fetch Thread status of ESPDevice failed with underlying error.
    case threadStatusError(Error)
    /// Unable to apply Thread settings to ESPDevice with status disconnected.
    case threadStatusDettached
    /// Wrong Thread credentials applied to ESPDevice.
    case threadDatasetInvalid
    /// Thread network not found.
    case threadStatusNetworkNotFound
    /// Thread status of ESPDevice is unknown.
    case threadStatusUnknownError
    /// Unkown error
    case unknownError
    
    public var description: String {
        switch self {
        case .sessionError:
            return "Session is not established or error while initialising session. Connect device again to retry"
        case .configurationError(let error):
            return "Failed to apply network configuration to device with error: \(error.localizedDescription)"
        case .wifiStatusError(let error):
            return "Unable to fetch wifi status with error: \(error.localizedDescription)"
        case .wifiStatusDisconnected:
            return "Wi-Fi status: disconnected"
        case .wifiStatusAuthenticationError:
            return "Wi-Fi status: authentication error"
        case .wifiStatusNetworkNotFound:
            return "Wi-Fi status: network not found"
        case .wifiStatusUnknownError:
            return "Wi-Fi status: unknown error"
        case .threadStatusError(let error):
            return "Unable to fetch wifi status with error: \(error.localizedDescription)"
        case .threadStatusDettached:
            return "Thread status: detached"
        case .threadDatasetInvalid:
            return "Thread status: dataset invalid"
        case .threadStatusNetworkNotFound:
            return "Thread status: network not found"
        case .threadStatusUnknownError:
            return "Thread status: unknown error"
        case .unknownError:
            return "Unknown error"
        }
    }
    
    public var code: Int {
        switch self {
        case .sessionError:
            return 31
        case .configurationError:
            return 32
        case .wifiStatusError:
            return 33
        case .wifiStatusDisconnected:
            return 34
        case .wifiStatusAuthenticationError:
            return 35
        case .wifiStatusNetworkNotFound:
            return 36
        case .wifiStatusUnknownError:
            return 37
        case .unknownError:
            return 38
        case .threadStatusError:
            return 0
        case .threadStatusDettached:
            return 1
        case .threadDatasetInvalid:
            return 2
        case .threadStatusNetworkNotFound:
            return 3
        case .threadStatusUnknownError:
            return 4
        }
    }
}




