import SwiftUI

struct InstancesSettings: View {
    @StateObject private var store = InstancesStore.shared

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            self.header
            if let err = store.lastError {
                Text("Error: \(err)")
                    .foregroundStyle(.red)
            } else if let info = store.statusMessage {
                Text(info)
                    .foregroundStyle(.secondary)
            }
            if self.store.instances.isEmpty {
                Text("No instances reported yet.")
                    .foregroundStyle(.secondary)
            } else {
                List(self.store.instances) { inst in
                    self.instanceRow(inst)
                }
                .listStyle(.inset)
            }
            Spacer()
        }
        .onAppear { self.store.start() }
        .onDisappear { self.store.stop() }
    }

    private var header: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text("Connected Instances")
                    .font(.headline)
                Text("Latest presence beacons from Clawdis nodes. Updated periodically.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if self.store.isLoading {
                ProgressView()
            } else {
                Button("Refresh") { Task { await self.store.refresh() } }
            }
        }
    }

    @ViewBuilder
    private func instanceRow(_ inst: InstanceInfo) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(inst.host ?? "unknown host").font(.subheadline.bold())
                if let ip = inst.ip { Text("(") + Text(ip).monospaced() + Text(")") }
            }
            HStack(spacing: 8) {
                if let version = inst.version {
                    self.label(icon: "shippingbox", text: version)
                }
                self.label(icon: "clock", text: inst.lastInputDescription)
                if let mode = inst.mode { self.label(icon: "network", text: mode) }
                if let reason = inst.reason, !reason.isEmpty {
                    self.label(icon: "info.circle", text: reason)
                }
            }
            Text(inst.text)
                .font(.footnote)
                .foregroundStyle(.secondary)
            Text(inst.ageDescription)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 6)
    }

    private func label(icon: String, text: String) -> some View {
        HStack(spacing: 4) {
            Image(systemName: icon).foregroundStyle(.secondary).font(.caption)
            Text(text)
        }
        .font(.footnote)
    }
}
