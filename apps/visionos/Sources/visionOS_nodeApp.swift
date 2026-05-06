//
//  visionOS_nodeApp.swift
//  visionOS-node
//
//  OpenClaw visionOS Node — LOAM STUDIO
//

import SwiftUI

// MARK: - AppDelegate (APNs token callbacks)

// REQUIRES: Push Notifications capability in Xcode + provisioning profile update
class AppDelegate: NSObject, UIApplicationDelegate {

    var apnsManager: APNsManager?

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        apnsManager?.didRegister(token: deviceToken)
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        apnsManager?.didFailToRegister(error: error)
    }
}

// MARK: - App

@main
struct visionOS_nodeApp: App {

    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var nodeManager = NodeManager()
    @State private var apnsManager = APNsManager()

    var body: some Scene {

        // Main window — connection status + settings
        WindowGroup {
            ContentView()
                .environmentObject(nodeManager)
                .scenePhaseMonitor(nodeManager: nodeManager)
                .onAppear {
                    apnsManager.nodeManager = nodeManager
                    appDelegate.apnsManager = apnsManager
                }
        }

        // ImmersiveSpace — REQUIRED for node lifecycle.
        // As long as this space is active, visionOS will NOT suspend
        // the process and the WebSocket stays alive.
        ImmersiveSpace(id: "NodeSpace") {
            NodeImmersiveView()
                .environmentObject(nodeManager)
        }
        .immersionStyle(selection: .constant(.mixed), in: .mixed)
    }
}
