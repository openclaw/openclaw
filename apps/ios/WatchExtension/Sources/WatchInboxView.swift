import SwiftUI

struct LiquidGlassButtonStyle: ButtonStyle {
    var role: ButtonRole?
    
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(.body, design: .rounded).weight(.medium))
            .padding(.vertical, 12)
            .padding(.horizontal, 16)
            .frame(maxWidth: .infinity)
            .background(
                Capsule()
                    .fill(role == .destructive ? Color.red.opacity(0.2) : Color.white.opacity(0.1))
                    .background(.ultraThinMaterial, in: Capsule())
            )
            .overlay(
                Capsule()
                    .strokeBorder(.white.opacity(configuration.isPressed ? 0.3 : 0.1), lineWidth: 1)
            )
            .scaleEffect(configuration.isPressed ? 0.94 : 1.0)
            .animation(.spring(response: 0.3, dampingFraction: 0.6), value: configuration.isPressed)
    }
}

struct WatchInboxView: View {
    @Bindable var store: WatchInboxStore
    var onAction: ((WatchPromptAction, String?) -> Void)?

    private func role(for action: WatchPromptAction) -> ButtonRole? {
        switch action.style?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "destructive":
            return .destructive
        case "cancel":
            return .cancel
        default:
            return nil
        }
    }

    var isHighRisk: Bool {
        store.risk?.lowercased() == "high"
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(store.title)
                        .font(.headline)
                        .lineLimit(2)
                    
                    Text(store.body)
                        .font(.body)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if let details = store.details, !details.isEmpty {
                    Text(details)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if store.isReplySending {
                    HStack {
                        Spacer()
                        ProgressView()
                            .progressViewStyle(.circular)
                            .tint(.white)
                        Text(store.replyStatusText ?? "Processing...")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .padding(.leading, 4)
                        Spacer()
                    }
                    .padding(.vertical, 8)
                    .transition(.opacity.combined(with: .scale))
                } else if let status = store.replyStatusText, !status.isEmpty {
                    HStack {
                        Spacer()
                        Image(systemName: status.contains("Failed") ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                            .foregroundStyle(status.contains("Failed") ? .red : .green)
                        Text(status)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                        Spacer()
                    }
                    .padding(.vertical, 8)
                    .transition(.opacity.combined(with: .scale))
                }

                if !store.actions.isEmpty && !store.isReplySending {
                    VStack(spacing: 8) {
                        ForEach(store.actions) { action in
                            Button(role: self.role(for: action)) {
                                withAnimation(.spring(response: 0.4, dampingFraction: 0.7)) {
                                    self.onAction?(action, nil)
                                }
                            } label: {
                                Text(action.label)
                            }
                            .buttonStyle(LiquidGlassButtonStyle(role: self.role(for: action)))
                        }
                    }
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                }
                
                // Voice First: Oracle Orb for dictation note
                if !store.isReplySending && !store.actions.isEmpty {
                    HStack {
                        Spacer()
                        ZStack {
                            Circle()
                                .fill(
                                    RadialGradient(gradient: Gradient(colors: [.blue.opacity(0.8), .purple.opacity(0.6)]), center: .center, startRadius: 0, endRadius: 22)
                                )
                                .shadow(color: .purple.opacity(0.5), radius: 8, x: 0, y: 0)

                            Image(systemName: "waveform")
                                .font(.system(size: 18, weight: .bold))
                                .foregroundStyle(.white)

                            TextField("Voice Reply...", text: Binding(
                                get: { "" },
                                set: { newValue in
                                    if !newValue.isEmpty, let defaultAction = store.actions.first {
                                        self.onAction?(defaultAction, newValue)
                                    }
                                }
                            ))
                            .opacity(0.02)
                            .buttonStyle(.plain)
                        }
                        .frame(width: 44, height: 44)
                        Spacer()
                    }
                    .padding(.top, 8)
                }

                if let updatedAt = store.updatedAt {
                    Text("Updated \(updatedAt.formatted(date: .omitted, time: .shortened))")
                        .font(.system(size: 10))
                        .foregroundStyle(.tertiary)
                        .frame(maxWidth: .infinity, alignment: .center)
                        .padding(.top, 4)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding()
        }
        .background(
            ZStack {
                if isHighRisk {
                    RoundedRectangle(cornerRadius: 24)
                        .strokeBorder(
                            AngularGradient(
                                gradient: Gradient(colors: [.red, .orange, .red]),
                                center: .center
                            ),
                            lineWidth: 2
                        )
                        .blur(radius: 4)
                        .ignoresSafeArea()
                }
            }
        )
        .onTapGesture(count: 2) {
            if !store.isReplySending, let defaultAction = store.actions.first(where: { self.role(for: $0) != .destructive && self.role(for: $0) != .cancel }) {
                withAnimation(.spring(response: 0.4, dampingFraction: 0.7)) {
                    self.onAction?(defaultAction, nil)
                }
            }
        }
        .animation(.default, value: store.isReplySending)
    }
}
