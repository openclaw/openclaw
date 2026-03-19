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
        case .table(let t):
            self.renderTable(t)
        case .richTextBlock(let rtb):
            self.renderRichTextBlock(rtb)
        case .codeBlock(let cb):
            self.renderCodeBlock(cb)
        case .imageSet(let imgSet):
            self.renderImageSet(imgSet)
        case .actionSet(let actSet):
            self.renderActions(actSet.actions)
        case .icon(let ico):
            self.renderIcon(ico)
        case .list(let lst):
            self.renderList(lst)
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
        case "extralarge":
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

    @ViewBuilder
    private func renderTable(_ table: CardElement.Table) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(table.rows.indices, id: \.self) { rowIdx in
                if let cells = table.rows[rowIdx].cells {
                    HStack(alignment: .top, spacing: 4) {
                        ForEach(cells.indices, id: \.self) { cellIdx in
                            VStack(alignment: .leading, spacing: 2) {
                                if let items = cells[cellIdx].items {
                                    ForEach(items.indices, id: \.self) { itemIdx in
                                        self.renderElement(items[itemIdx])
                                    }
                                }
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(4)
                        }
                    }
                    // Bold the first row as header
                    .fontWeight(rowIdx == 0 ? .semibold : .regular)
                    if rowIdx == 0 {
                        Divider()
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func renderRichTextBlock(_ rtb: CardElement.RichTextBlock) -> some View {
        // Build an attributed text from inlines
        let combined = rtb.inlines.reduce(Text("")) { result, run in
            var segment = Text(run.text)
            if run.weight?.lowercased() == "bolder" {
                segment = segment.bold()
            }
            if run.italic == true {
                segment = segment.italic()
            }
            if run.strikethrough == true {
                segment = segment.strikethrough()
            }
            if let size = run.size?.lowercased() {
                switch size {
                case "small":
                    segment = segment.font(.caption)
                case "large":
                    segment = segment.font(.title2)
                case "extralarge":
                    segment = segment.font(.title)
                default:
                    break
                }
            }
            return result + segment
        }
        combined
            .fixedSize(horizontal: false, vertical: true)
    }

    @ViewBuilder
    private func renderCodeBlock(_ cb: CardElement.CodeBlock) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if let lang = cb.language, !lang.isEmpty {
                Text(lang)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            Text(cb.codeSnippet)
                .font(.system(.caption, design: .monospaced))
                .padding(8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(self.codeBlockBackground)
                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        }
    }

    @ViewBuilder
    private func renderImageSet(_ imgSet: CardElement.ImageSet) -> some View {
        let size = imgSet.imageSize ?? "medium"
        LazyVGrid(columns: [GridItem(.adaptive(minimum: self.imageMaxHeight(size)))], spacing: 6) {
            ForEach(imgSet.images.indices, id: \.self) { i in
                self.renderImage(imgSet.images[i])
            }
        }
    }

    // MARK: - Icon rendering

    @ViewBuilder
    private func renderIcon(_ icon: ACIcon) -> some View {
        self.iconView(icon)
    }

    /// Builds a view for an ACIcon: SF Symbol when the name matches, otherwise a text label.
    @ViewBuilder
    private func iconView(_ icon: ACIcon) -> some View {
        let iconSize = self.iconFontSize(icon.size)
        let iconColor = self.iconColor(icon.color)

        // Attempt SF Symbol lookup; fall back to a text label
        if self.sfSymbolExists(icon.name) {
            Image(systemName: icon.name)
                .font(.system(size: iconSize))
                .foregroundStyle(iconColor)
        } else {
            Text(icon.name)
                .font(.system(size: iconSize))
                .foregroundStyle(iconColor)
        }
    }

    /// Map Adaptive Card icon size tokens to point sizes.
    private func iconFontSize(_ size: String?) -> CGFloat {
        switch size?.lowercased() {
        case "xxs": return 10
        case "xs": return 12
        case "sm", "small": return 14
        case "md", "medium": return 18
        case "lg", "large": return 24
        case "xl": return 30
        case "xxl": return 38
        default: return 16
        }
    }

    /// Resolve Adaptive Card color tokens to SwiftUI colors.
    private func iconColor(_ color: String?) -> Color {
        switch color?.lowercased() {
        case "accent": return .accentColor
        case "good": return .green
        case "warning": return .orange
        case "attention": return .red
        case "light": return .secondary
        case "dark": return .primary
        default: return .primary
        }
    }

    /// Check whether an SF Symbol name is valid at runtime.
    private func sfSymbolExists(_ name: String) -> Bool {
        #if canImport(UIKit)
        return UIImage(systemName: name) != nil
        #elseif canImport(AppKit)
        return NSImage(systemSymbolName: name, accessibilityDescription: nil) != nil
        #else
        return false
        #endif
    }

    // MARK: - List rendering

    @ViewBuilder
    private func renderList(_ list: ACList) -> some View {
        let ordered = list.style?.lowercased() == "ordered"
        VStack(alignment: .leading, spacing: 4) {
            ForEach(list.items.indices, id: \.self) { idx in
                HStack(alignment: .top, spacing: 4) {
                    if let icon = list.items[idx].icon {
                        self.iconView(icon)
                    }
                    let prefix = ordered ? "\(idx + 1)." : "\u{2022}"
                    Text("\(prefix) \(list.items[idx].text)")
                        .font(.subheadline)
                        .fixedSize(horizontal: false, vertical: true)
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
                // No-op: submit actions require server-side routing
            } label: {
                Text(a.title ?? "Submit")
                    .font(.caption)
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .disabled(true)
            .help("Submit actions require server-side routing and are not supported in this view.")
        case .execute(let a):
            Button {
                // No-op: execute actions require server-side routing
            } label: {
                Text(a.title ?? "Execute")
                    .font(.caption)
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .disabled(true)
            .help("Execute actions require server-side routing and are not supported in this view.")
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

    private var codeBlockBackground: Color {
        self.colorScheme == .dark
            ? Color.white.opacity(0.08)
            : Color.black.opacity(0.05)
    }
}
