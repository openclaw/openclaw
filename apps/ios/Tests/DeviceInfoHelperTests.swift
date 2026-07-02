import Foundation
import Testing
import UIKit
@testable import OpenClaw

struct DeviceInfoHelperTests {
    @Test func `known iPhone identifier maps to marketing name`() {
        #expect(
            DeviceInfoHelper.deviceDisplayName(
                identifier: "iPhone15,2",
                userInterfaceIdiom: .phone) == "iPhone 14 Pro")
    }

    @Test func `known iPad identifier maps to marketing name`() {
        #expect(
            DeviceInfoHelper.deviceDisplayName(
                identifier: "iPad14,3",
                userInterfaceIdiom: .pad) == "iPad Pro 11-inch (4th generation)")
    }

    @Test func `unknown iPhone identifier falls back to family and identifier`() {
        #expect(
            DeviceInfoHelper.deviceDisplayName(
                identifier: "iPhone99,1",
                userInterfaceIdiom: .phone) == "iPhone (iPhone99,1)")
    }

    @Test func `unknown iPad identifier falls back to family and identifier`() {
        #expect(
            DeviceInfoHelper.deviceDisplayName(
                identifier: "iPad99,1",
                userInterfaceIdiom: .pad) == "iPad (iPad99,1)")
    }

    @Test func `raw host architecture falls back to iOS device`() {
        #expect(
            DeviceInfoHelper.deviceDisplayName(
                identifier: "arm64",
                userInterfaceIdiom: .phone) == "iOS Device (arm64)")
    }

    @Test func `simulator device name overrides host architecture and model identifier`() {
        #expect(
            DeviceInfoHelper.deviceDisplayName(
                identifier: "arm64",
                userInterfaceIdiom: .phone,
                environment: [
                    "SIMULATOR_DEVICE_NAME": "iPhone 17 Pro",
                    "SIMULATOR_MODEL_IDENTIFIER": "iPhone18,1",
                ]) == "iPhone 17 Pro")
    }

    @Test func `simulator model identifier resolves when device name is unavailable`() {
        #expect(
            DeviceInfoHelper.deviceDisplayName(
                identifier: "arm64",
                userInterfaceIdiom: .pad,
                environment: [
                    "SIMULATOR_MODEL_IDENTIFIER": "iPad14,3",
                ]) == "iPad Pro 11-inch (4th generation)")
    }

    @Test func `iOS version display omits platform prefix`() {
        let version = OperatingSystemVersion(majorVersion: 26, minorVersion: 5, patchVersion: 0)

        #expect(DeviceInfoHelper.iOSVersionStringForDisplay(version) == "26.5.0")
    }
}
