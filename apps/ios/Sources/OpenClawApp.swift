import SwiftUI
import Foundation
import os
import UIKit
import BackgroundTasks

final class OpenClawAppDelegate: NSObject, UIApplicationDelegate {
    private let logger = Logger(subsystem: "ai.openclaw.ios", category: "Push")
    private let backgroundWakeLogger = Logger(subsystem: "ai.openclaw.ios", category: "BackgroundWake")
    private static let wakeRefreshTaskIdentifier = "ai.openclaw.ios.bgrefresh"
    private var backgroundWakeTask: Task<Bool, Never>?
    private var pendingAPNsDeviceToken: Data?
    weak var appModel: NodeAppModel? {
        didSet {
            guard let model = self.appModel, let token = self.pendingAPNsDeviceToken else { return }
            self.pendingAPNsDeviceToken = nil
            Task { @MainActor in
                model.updateAPNsDeviceToken(token)
            }
        }
    }

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool
    {
        self.registerBackgroundWakeRefreshTask()
        application.registerForRemoteNotifications()
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        if let appModel = self.appModel {
            Task { @MainActor in
                appModel.updateAPNsDeviceToken(deviceToken)
            }
            return
        }

        self.pendingAPNsDeviceToken = deviceToken
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error) {
        self.logger.error("APNs registration failed: \(error.localizedDescription, privacy: .public)")
    }

    func application(
        _ application: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void)
    {
        self.logger.info("APNs remote notification received keys=\(userInfo.keys.count, privacy: .public)")
        Task { @MainActor in
            guard let appModel = self.appModel else {
                self.logger.info("APNs wake skipped: appModel unavailable")
                self.scheduleBackgroundWakeRefresh(afterSeconds: 90, reason: "silent_push_no_model")
                completionHandler(.noData)
                return
            }
            let handled = await appModel.handleSilentPushWake(userInfo)
            self.logger.info("APNs wake handled=\(handled, privacy: .public)")
            if !handled {
                self.scheduleBackgroundWakeRefresh(afterSeconds: 90, reason: "silent_push_not_applied")
            }
            completionHandler(handled ? .newData : .noData)
        }
    }

    func scenePhaseChanged(_ phase: ScenePhase) {
        if phase == .background {
            self.scheduleBackgroundWakeRefresh(afterSeconds: 120, reason: "scene_background")
        }
    }

    private func registerBackgroundWakeRefreshTask() {
        BGTaskScheduler.shared.register(
            forTaskWithIdentifier: Self.wakeRefreshTaskIdentifier,
            using: nil
        ) { [weak self] task in
            guard let refreshTask = task as? BGAppRefreshTask else {
                task.setTaskCompleted(success: false)
                return
            }
            self?.handleBackgroundWakeRefresh(task: refreshTask)
        }
    }

    private func scheduleBackgroundWakeRefresh(afterSeconds delay: TimeInterval, reason: String) {
        let request = BGAppRefreshTaskRequest(identifier: Self.wakeRefreshTaskIdentifier)
        request.earliestBeginDate = Date().addingTimeInterval(max(60, delay))
        do {
            try BGTaskScheduler.shared.submit(request)
            self.backgroundWakeLogger.info(
                "Scheduled background wake refresh reason=\(reason, privacy: .public) delaySeconds=\(max(60, delay), privacy: .public)")
        } catch {
            self.backgroundWakeLogger.error(
                "Failed scheduling background wake refresh reason=\(reason, privacy: .public) error=\(error.localizedDescription, privacy: .public)")
        }
    }

    private func handleBackgroundWakeRefresh(task: BGAppRefreshTask) {
        self.scheduleBackgroundWakeRefresh(afterSeconds: 15 * 60, reason: "reschedule")
        self.backgroundWakeTask?.cancel()

        let wakeTask = Task { @MainActor [weak self] in
            guard let self, let appModel = self.appModel else { return false }
            return await appModel.handleBackgroundRefreshWake(trigger: "bg_app_refresh")
        }
        self.backgroundWakeTask = wakeTask
        task.expirationHandler = {
            wakeTask.cancel()
        }
        Task {
            let applied = await wakeTask.value
            task.setTaskCompleted(success: applied)
            self.backgroundWakeLogger.info(
                "Background wake refresh finished applied=\(applied, privacy: .public)")
        }
    }
}

@main
struct OpenClawApp: App {
    @State private var appModel: NodeAppModel
    @State private var gatewayController: GatewayConnectionController
    @UIApplicationDelegateAdaptor(OpenClawAppDelegate.self) private var appDelegate
    @Environment(\.scenePhase) private var scenePhase

    init() {
        Self.installUncaughtExceptionLogger()
        GatewaySettingsStore.bootstrapPersistence()
        let appModel = NodeAppModel()
        _appModel = State(initialValue: appModel)
        _gatewayController = State(initialValue: GatewayConnectionController(appModel: appModel))
    }

    var body: some Scene {
        WindowGroup {
            RootCanvas()
                .environment(self.appModel)
                .environment(self.appModel.voiceWake)
                .environment(self.gatewayController)
                .task {
                    self.appDelegate.appModel = self.appModel
                }
                .onOpenURL { url in
                    Task { await self.appModel.handleDeepLink(url: url) }
                }
                .onChange(of: self.scenePhase) { _, newValue in
                    self.appModel.setScenePhase(newValue)
                    self.gatewayController.setScenePhase(newValue)
                    self.appDelegate.scenePhaseChanged(newValue)
                }
        }
    }
}

extension OpenClawApp {
    private static func installUncaughtExceptionLogger() {
        NSLog("OpenClaw: installing uncaught exception handler")
        NSSetUncaughtExceptionHandler { exception in
            // Useful when the app hits NSExceptions from SwiftUI/WebKit internals; these do not
            // produce a normal Swift error backtrace.
            let reason = exception.reason ?? "(no reason)"
            NSLog("UNCAUGHT EXCEPTION: %@ %@", exception.name.rawValue, reason)
            for line in exception.callStackSymbols {
                NSLog("  %@", line)
            }
        }
    }
}
