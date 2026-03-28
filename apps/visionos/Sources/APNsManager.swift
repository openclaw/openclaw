//
//  APNsManager.swift
//  visionOS-node
//
//  OpenClaw visionOS Node — LOAM STUDIO
//
//  Registers for APNs silent push notifications and forwards
//  the device token to the gateway via node.apns.
//
//  REQUIRES: Push Notifications capability in Xcode + provisioning profile update
//

import SwiftUI
import UserNotifications

@MainActor
final class APNsManager {

    weak var nodeManager: NodeManager?

    init() {
        requestAuthorization()
    }

    // MARK: - Authorization + Registration

    private func requestAuthorization() {
        Task {
            do {
                let granted = try await UNUserNotificationCenter.current()
                    .requestAuthorization(options: [])
                print("[APNsManager] Authorization \(granted ? "granted" : "denied")")
                if granted {
                    // visionOS uses UIApplication for remote notification registration
                    // just like iOS/iPadOS (visionOS is built on UIKit foundations).
                    #if canImport(UIKit)
                    UIApplication.shared.registerForRemoteNotifications()
                    #else
                    print("[APNsManager] UIApplication unavailable — cannot register for remote notifications")
                    #endif
                }
            } catch {
                print("[APNsManager] Authorization error: \(error)")
            }
        }
    }

    // MARK: - Token callbacks

    func didRegister(token: Data) {
        let hex = token.map { String(format: "%02x", $0) }.joined()
        print("[APNsManager] APNs registered: \(hex.prefix(8))...")

        guard let nodeManager else {
            print("[APNsManager] No nodeManager attached — token not forwarded")
            return
        }

        // Send token to gateway: { type:"req", method:"node.apns", params:{ token:"<hex>" } }
        Task {
            nodeManager.sendRequest(method: "node.apns", params: ["token": hex])
        }
    }

    func didFailToRegister(error: Error) {
        print("[APNsManager] Registration failed: \(error.localizedDescription)")
    }
}
