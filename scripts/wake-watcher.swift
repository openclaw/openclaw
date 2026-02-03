#!/usr/bin/env swift
// wake-watcher.swift — restarts Moltbot gateway when macOS wakes from sleep.
// Runs as a LaunchAgent daemon.

import Cocoa
import Foundation

let ws = NSWorkspace.shared.notificationCenter

ws.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { _ in
    // Wait for network to stabilize
    DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/opt/homebrew/bin/moltbot")
        task.arguments = ["gateway", "restart", "--reason", "macOS wake from sleep"]
        task.environment = ProcessInfo.processInfo.environment
        try? task.run()
        task.waitUntilExit()

        if task.terminationStatus != 0 {
            // Fallback: kickstart launchd service
            let fallback = Process()
            fallback.executableURL = URL(fileURLWithPath: "/bin/launchctl")
            fallback.arguments = ["kickstart", "-k", "gui/\(getuid())/bot.molt.gateway"]
            try? fallback.run()
        }
    }
}

// Keep running
RunLoop.main.run()
