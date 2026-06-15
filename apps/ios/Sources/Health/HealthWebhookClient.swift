import Foundation
import os

// MARK: - HealthWebhookUploading

/// Testable POST abstraction so the orchestrator can be unit-tested without real networking.
protocol HealthWebhookUploading: Sendable {
    /// POSTs the JSON body to the validated webhook. Throws `HealthExportError` on any non-2xx
    /// status (classified into `.clientError` for 4xx vs `.serverOrNetwork` for 5xx/transport).
    func post(body: Data, config: HealthWebhookConfig) async throws
}

// MARK: - LiveHealthWebhookClient

struct LiveHealthWebhookClient: HealthWebhookUploading {
    private let session: URLSession
    private let logger = Logger(subsystem: "ai.openclaw.ios", category: "HealthExport")

    init(session: URLSession = .shared) {
        self.session = session
    }

    func post(body: Data, config: HealthWebhookConfig) async throws {
        // Defense in depth: re-validate the URL right before sending, in case anything bypassed
        // the config store. Health data must only ever leave to an https `.ts.net` host.
        guard HealthExportConfigStore.validatedURL(from: config.url.absoluteString) != nil else {
            throw HealthExportError.invalidWebhookURL
        }

        var request = URLRequest(url: config.url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(config.token)", forHTTPHeaderField: "Authorization")
        request.httpBody = body
        request.timeoutInterval = 60

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await self.session.data(for: request)
        } catch {
            // Transport failure (offline, TLS, DNS) — retryable.
            self.logger.info("HealthExport: POST transport error: \(error.localizedDescription, privacy: .private)")
            throw HealthExportError.serverOrNetwork(status: nil)
        }
        _ = data

        guard let http = response as? HTTPURLResponse else {
            throw HealthExportError.serverOrNetwork(status: nil)
        }

        switch http.statusCode {
        case 200...299:
            return
        case 400...499:
            // 401 (bad token) / 422 (bad shape) etc. — do NOT retry in a loop; surface to user.
            throw HealthExportError.clientError(status: http.statusCode)
        default:
            // 5xx and anything else — retryable.
            throw HealthExportError.serverOrNetwork(status: http.statusCode)
        }
    }
}
