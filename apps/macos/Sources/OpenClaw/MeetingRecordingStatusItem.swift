import AppKit
import Observation

@MainActor
final class MeetingRecordingStatusItem {
    static let shared = MeetingRecordingStatusItem()

    private var statusItem: NSStatusItem?
    private var timer: Timer?
    private var observationTask: Task<Void, Never>?

    func start() {
        self.observationTask = Task { [weak self] in
            let detector = MeetingDetector.shared
            var wasRecording = false
            while !Task.isCancelled {
                let isRecording = detector.currentSession != nil
                if isRecording != wasRecording {
                    wasRecording = isRecording
                    if isRecording {
                        self?.show()
                    } else {
                        self?.hide()
                    }
                }
                try? await Task.sleep(nanoseconds: 500_000_000)
            }
        }
    }

    private func show() {
        guard self.statusItem == nil else { return }
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.action = #selector(self.clicked(_:))
        item.button?.target = self
        self.statusItem = item
        self.updateTitle()
        self.timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.updateTitle()
            }
        }
    }

    private func hide() {
        self.timer?.invalidate()
        self.timer = nil
        if let item = self.statusItem {
            NSStatusBar.system.removeStatusItem(item)
            self.statusItem = nil
        }
    }

    private func updateTitle() {
        guard let session = MeetingDetector.shared.currentSession,
              let button = self.statusItem?.button else { return }

        let duration = session.formattedDuration
        let attributed = NSMutableAttributedString()

        // Red dot
        let dot = NSAttributedString(
            string: "\u{25CF} ",
            attributes: [
                .foregroundColor: NSColor.systemRed,
                .font: NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular),
            ])
        attributed.append(dot)

        // Timer text
        let text = NSAttributedString(
            string: duration,
            attributes: [
                .font: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .medium),
            ])
        attributed.append(text)

        button.attributedTitle = attributed
    }

    @objc private func clicked(_ sender: Any?) {
        // Stop the meeting when clicking the timer
        Task { await MeetingDetector.shared.stopMeeting() }
    }
}
