import SwiftUI

extension ConnectionsSettings {
    var body: some View {
        NavigationSplitView {
            self.sidebar
        } detail: {
            self.detail
        }
        .onAppear {
            self.store.start()
            self.ensureSelection()
        }
        .onChange(of: self.orderedProviders) { _, _ in
            self.ensureSelection()
        }
        .onDisappear { self.store.stop() }
    }

    private var sidebar: some View {
        List(selection: self.$selectedProvider) {
            if !self.enabledProviders.isEmpty {
                Section("Configured") {
                    ForEach(self.enabledProviders) { provider in
                        self.sidebarRow(provider)
                            .tag(provider)
                    }
                }
            }

            if !self.availableProviders.isEmpty {
                Section("Available") {
                    ForEach(self.availableProviders) { provider in
                        self.sidebarRow(provider)
                            .tag(provider)
                    }
                }
            }
        }
        .listStyle(.sidebar)
        .frame(minWidth: 210, idealWidth: 230, maxWidth: 260)
    }

    private var detail: some View {
        Group {
            if let provider = self.selectedProvider {
                self.providerDetail(provider)
            } else {
                self.emptyDetail
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var emptyDetail: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Connections")
                .font(.title3.weight(.semibold))
            Text("Select a provider to view status and settings.")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 18)
    }

    private func providerDetail(_ provider: ConnectionProvider) -> some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 16) {
                self.detailHeader(for: provider)
                Divider()
                self.providerSection(provider)
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 24)
            .padding(.vertical, 18)
        }
    }

    private func sidebarRow(_ provider: ConnectionProvider) -> some View {
        HStack(spacing: 8) {
            Circle()
                .fill(self.providerTint(provider))
                .frame(width: 8, height: 8)
            VStack(alignment: .leading, spacing: 2) {
                Text(provider.title)
                Text(self.providerSummary(provider))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
    }

    private func detailHeader(for provider: ConnectionProvider) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Label(provider.detailTitle, systemImage: provider.systemImage)
                    .font(.title3.weight(.semibold))
                self.statusBadge(
                    self.providerSummary(provider),
                    color: self.providerTint(provider))
                Spacer()
                self.providerHeaderActions(provider)
            }

            HStack(spacing: 10) {
                Text("Last check \(self.providerLastCheckText(provider))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if self.providerHasError(provider) {
                    Text("Error")
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color.red.opacity(0.15))
                        .foregroundStyle(.red)
                        .clipShape(Capsule())
                }
            }

            if let details = self.providerDetails(provider) {
                Text(details)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func statusBadge(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(color.opacity(0.16))
            .foregroundStyle(color)
            .clipShape(Capsule())
    }
}
