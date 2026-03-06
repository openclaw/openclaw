import AppKit
import CoreImage
import CoreImage.CIFilterBuiltins
import SwiftUI

enum GatewaySetupCodeEncoder {
    static func encode(urlString: String, token: String?, password: String?) -> String? {
        let trimmedURL = urlString.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedURL.isEmpty else { return nil }

        var payload: [String: String] = ["url": trimmedURL]
        if let token = Self.normalizedSecret(token) {
            payload["token"] = token
        }
        if let password = Self.normalizedSecret(password) {
            payload["password"] = password
        }

        guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]) else {
            return nil
        }

        return data
            .base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private static func normalizedSecret(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

private struct GatewayQRCodePayload: Equatable {
    let tailscaleIP: String?
    let host: String
    let port: Int
    let tlsEnabled: Bool
    let token: String?
    let setupCode: String

    var websocketURL: String {
        var components = URLComponents()
        components.scheme = self.tlsEnabled ? "wss" : "ws"
        components.host = self.host
        components.port = self.port
        return components.string ?? "\(self.tlsEnabled ? "wss" : "ws")://\(self.host):\(self.port)"
    }

    var securityLabel: String {
        self.tlsEnabled ? "TLS (wss)" : "Unencrypted (ws)"
    }
}

struct GatewayConnectQRCodeSection: View {
    @Environment(TailscaleService.self) private var tailscaleService

    @State private var payload: GatewayQRCodePayload?
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var copyStatus: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Connect iOS app")
                    .font(.callout.weight(.semibold))
                Spacer()
                Button {
                    Task { await self.refreshPayload() }
                } label: {
                    if self.isLoading {
                        ProgressView().controlSize(.small)
                    } else {
                        Text("Refresh")
                    }
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(self.isLoading)
            }

            Text("Scan this QR code in the iOS app to import gateway host, security mode, port, and token.")
                .font(.caption)
                .foregroundStyle(.secondary)

            if let payload {
                HStack(alignment: .top, spacing: 14) {
                    if let qrImage = Self.qrImage(from: payload.setupCode) {
                        Image(nsImage: qrImage)
                            .resizable()
                            .interpolation(.none)
                            .frame(width: 150, height: 150)
                            .background(Color.white)
                            .cornerRadius(8)
                    } else {
                        RoundedRectangle(cornerRadius: 8)
                            .fill(Color.gray.opacity(0.12))
                            .frame(width: 150, height: 150)
                            .overlay {
                                Text("QR unavailable")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                    }

                    VStack(alignment: .leading, spacing: 6) {
                        self.detailRow(label: "Tailscale IP", value: payload.tailscaleIP ?? "Unavailable")
                        self.detailRow(label: "Gateway host", value: payload.host)
                        self.detailRow(label: "Security", value: payload.securityLabel)
                        self.detailRow(label: "TCP port", value: String(payload.port))
                        self.detailRow(label: "Gateway token", value: payload.token ?? "Not set")
                        self.detailRow(label: "URL", value: payload.websocketURL)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }

                HStack(spacing: 10) {
                    Button("Copy setup code") {
                        self.copyToPasteboard(payload.setupCode)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)

                    Button("Copy URL") {
                        self.copyToPasteboard(payload.websocketURL)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)

                    if let token = payload.token, !token.isEmpty {
                        Button("Copy token") {
                            self.copyToPasteboard(token)
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                    }
                }
            } else if self.isLoading {
                Text("Loading gateway details...")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else if let errorMessage {
                Text(errorMessage)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                Text("Gateway details unavailable.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if let copyStatus {
                Text(copyStatus)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(12)
        .background(Color.gray.opacity(0.08))
        .cornerRadius(10)
        .task(id: self.tailscaleService.tailscaleIP ?? "no-tailnet-ip") {
            await self.refreshPayload()
        }
    }

    @ViewBuilder
    private func detailRow(label: String, value: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text("\(label):")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(value)
                .font(.system(.caption, design: .monospaced))
                .textSelection(.enabled)
                .lineLimit(2)
                .truncationMode(.middle)
        }
    }

    @MainActor
    private func refreshPayload() async {
        self.isLoading = true
        defer { self.isLoading = false }

        do {
            let config = try await GatewayEndpointStore.shared.requireConfig()
            guard let scheme = config.url.scheme?.lowercased(),
                  scheme == "ws" || scheme == "wss"
            else {
                self.payload = nil
                self.errorMessage = "Gateway URL must use ws:// or wss://."
                return
            }

            let tlsEnabled = scheme == "wss"
            let port = config.url.port ?? (tlsEnabled ? 443 : 18789)
            let fallbackHost = config.url.host?.trimmingCharacters(in: .whitespacesAndNewlines)
            let tailscaleIP = (
                self.tailscaleService.tailscaleIP ??
                    TailscaleService.fallbackTailnetIPv4()
            )?.trimmingCharacters(in: .whitespacesAndNewlines)
            let host = (tailscaleIP?.isEmpty == false ? tailscaleIP : fallbackHost) ?? ""

            guard !host.isEmpty else {
                self.payload = nil
                self.errorMessage = "No gateway host or Tailscale IP found."
                return
            }

            var components = URLComponents()
            components.scheme = tlsEnabled ? "wss" : "ws"
            components.host = host
            components.port = port
            guard let urlString = components.string else {
                self.payload = nil
                self.errorMessage = "Failed to build gateway URL."
                return
            }

            let token = config.token?.trimmingCharacters(in: .whitespacesAndNewlines)
            let password = config.password?.trimmingCharacters(in: .whitespacesAndNewlines)
            guard let setupCode = GatewaySetupCodeEncoder.encode(
                urlString: urlString,
                token: token,
                password: password)
            else {
                self.payload = nil
                self.errorMessage = "Failed to build setup code payload."
                return
            }

            self.payload = GatewayQRCodePayload(
                tailscaleIP: tailscaleIP?.isEmpty == false ? tailscaleIP : nil,
                host: host,
                port: port,
                tlsEnabled: tlsEnabled,
                token: token?.isEmpty == false ? token : nil,
                setupCode: setupCode)
            self.errorMessage = nil
        } catch {
            self.payload = nil
            self.errorMessage = error.localizedDescription
        }
    }

    private func copyToPasteboard(_ value: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(value, forType: .string)
        self.copyStatus = "Copied to clipboard."
    }

    private static let qrContext = CIContext()

    private static func qrImage(from payload: String) -> NSImage? {
        let data = Data(payload.utf8)
        let filter = CIFilter.qrCodeGenerator()
        filter.setValue(data, forKey: "inputMessage")
        filter.setValue("M", forKey: "inputCorrectionLevel")

        guard let output = filter.outputImage else { return nil }
        let scaled = output.transformed(by: CGAffineTransform(scaleX: 8, y: 8))
        guard let cgImage = Self.qrContext.createCGImage(scaled, from: scaled.extent) else { return nil }
        return NSImage(cgImage: cgImage, size: NSSize(width: scaled.extent.width, height: scaled.extent.height))
    }
}
