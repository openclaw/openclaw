import SwiftUI

/// Renders a parsed Adaptive Card inline in the chat bubble.
@MainActor
struct AdaptiveCardView: View {
    let card: AdaptiveCard
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(self.card.body.indices, id: \.self) { i in
                self.renderElement(self.card.body[i])
            }
            if let actions = self.card.actions, !actions.isEmpty {
                self.renderActions(actions)
            }
        }
        .padding(10)
        .background(self.cardBackground)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(self.borderColor, lineWidth: 0.5))
    }

    // MARK: - Element rendering

    @ViewBuilder
    private func renderElement(_ element: CardElement) -> some View {
        switch element {
        case .textBlock(let tb):
            self.renderTextBlock(tb)
        case .factSet(let fs):
            self.renderFactSet(fs)
        case .columnSet(let cs):
            self.renderColumnSet(cs)
        case .container(let c):
            self.renderContainer(c)
        case .image(let img):
            self.renderImage(img)
        case .unknown:
            EmptyView()
        }
    }

    @ViewBuilder
    private func renderTextBlock(_ tb: CardElement.TextBlock) -> some View {
        if tb.separator == true {
            Divider()
        }
        Text(tb.text)
            .font(self.textBlockFont(tb))
            .fontWeight(tb.weight?.lowercased() == "bolder" ? .bold : .regular)
            .foregroundStyle(tb.isSubtle == true ? .secondary : .primary)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func textBlockFont(_ tb: CardElement.TextBlock) -> Font {
        switch tb.size?.lowercased() {
        case "extralarge", "extraLarge":
            return .title
        case "large":
            return .title2
        case "medium":
            return .body
        case "small":
            return .caption
        default:
            return .subheadline
        }
    }

    @ViewBuilder
    private func renderFactSet(_ fs: CardElement.FactSet) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(fs.facts.indices, id: \.self) { i in
                HStack(alignment: .top, spacing: 8) {
                    Text(fs.facts[i].title)
                        .font(.caption)
                        .fontWeight(.semibold)
                        .foregroundStyle(.secondary)
                        .frame(minWidth: 80, alignment: .leading)
                    Text(fs.facts[i].value)
                        .font(.caption)
                }
            }
        }
    }

    @ViewBuilder
    private func renderColumnSet(_ cs: CardElement.ColumnSet) -> some View {
        HStack(alignment: .top, spacing: 8) {
            ForEach(cs.columns.indices, id: \.self) { i in
                VStack(alignment: .leading, spacing: 6) {
                    if let items = cs.columns[i].items {
                        ForEach(items.indices, id: \.self) { j in
                            self.renderElement(items[j])
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    @ViewBuilder
    private func renderContainer(_ container: CardElement.Container) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(container.items.indices, id: \.self) { i in
                self.renderElement(container.items[i])
            }
        }
        .padding(container.style != nil ? 6 : 0)
        .background(
            container.style != nil
                ? AnyShapeStyle(self.containerAccentColor.opacity(0.08))
                : AnyShapeStyle(.clear))
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
    }

    @ViewBuilder
    private func renderImage(_ img: CardElement.ImageElement) -> some View {
        if let url = URL(string: img.url) {
            AsyncImage(url: url) { phase in
                switch phase {
                case .success(let image):
                    image
                        .resizable()
                        .scaledToFit()
                        .frame(maxHeight: self.imageMaxHeight(img.size))
                        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                case .failure:
                    Label(img.altText ?? "Image", systemImage: "photo")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                default:
                    ProgressView()
                        .frame(height: 40)
                }
            }
        }
    }

    private func imageMaxHeight(_ size: String?) -> CGFloat {
        switch size?.lowercased() {
        case "small": return 60
        case "medium": return 120
        case "large": return 200
        default: return 160
        }
    }

    // MARK: - Action rendering

    @ViewBuilder
    private func renderActions(_ actions: [CardAction]) -> some View {
        HStack(spacing: 8) {
            ForEach(actions.indices, id: \.self) { i in
                self.renderAction(actions[i])
            }
        }
    }

    @ViewBuilder
    private func renderAction(_ action: CardAction) -> some View {
        switch action {
        case .openUrl(let a):
            if let url = URL(string: a.url) {
                Button {
                    self.openURL(url)
                } label: {
                    Text(a.title ?? "Open")
                        .font(.caption)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            }
        case .submit(let a):
            Button {
                // Submit action tap (logged for debugging)
                print("[AdaptiveCard] Action.Submit tapped: \(a.title ?? "untitled")")
            } label: {
                Text(a.title ?? "Submit")
                    .font(.caption)
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        case .unknown:
            EmptyView()
        }
    }

    // MARK: - Colors

    private var cardBackground: Color {
        self.colorScheme == .dark
            ? Color.white.opacity(0.05)
            : Color.black.opacity(0.03)
    }

    private var borderColor: Color {
        self.colorScheme == .dark
            ? Color.white.opacity(0.12)
            : Color.black.opacity(0.1)
    }

    private var containerAccentColor: Color {
        self.colorScheme == .dark
            ? Color.white
            : Color.black
    }
}
