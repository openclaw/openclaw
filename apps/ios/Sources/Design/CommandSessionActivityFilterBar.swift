import SwiftUI

struct CommandSessionActivityFilterBar: View {
    @Binding var selection: CommandSessionActivityFilter
    let snapshot: CommandSessionActivitySnapshot

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) { self.buttons }
            VStack(alignment: .leading, spacing: 4) { self.buttons }
        }
    }

    private var buttons: some View {
        ForEach(CommandSessionActivityFilter.allCases, id: \.self) { filter in
            Button {
                self.selection = filter
            } label: {
                HStack(spacing: 5) {
                    Text(verbatim: filter.title)
                        .font(OpenClawType.captionSemiBold)
                    Text(verbatim: self.snapshot.countText(for: filter))
                        .font(OpenClawType.captionMedium)
                        .monospacedDigit()
                }
                .fixedSize(horizontal: true, vertical: false)
                .padding(.horizontal, 10)
                .frame(minHeight: 44)
                .foregroundStyle(self.selection == filter ? OpenClawBrand.accent : .secondary)
                .background(
                    self.selection == filter ? OpenClawBrand.accent.opacity(0.12) : .clear,
                    in: Capsule())
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(filter != .all && !self.snapshot.isConnected)
            .accessibilityLabel(filter.title)
            .accessibilityValue(self.snapshot.countText(for: filter))
            .accessibilityAddTraits(self.selection == filter ? .isSelected : [])
            .accessibilityIdentifier("Sessions.Activity.\(filter.rawValue)")
        }
    }
}
