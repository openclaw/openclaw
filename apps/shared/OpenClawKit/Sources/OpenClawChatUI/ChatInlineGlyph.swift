#if os(iOS)
import CoreText
import SwiftUI
import UIKit

/// The same masks as chat/text.css, drawn in the surrounding link ink. Text(Image) lays out
/// using the image's natural size, so rasterize the vector at this text run's actual metrics.
@MainActor
enum ChatInlineGlyph {
    private static let cache = NSCache<NSString, UIImage>()

    static func text(for name: String, font: Font, environment: EnvironmentValues) -> Text {
        // An image exactly one cap tall, with its bottom at the baseline, fits inside the line.
        let side: CGFloat = if #available(iOS 26, *) {
            CTFontGetCapHeight(font.resolve(in: environment.fontResolutionContext).ctFont)
        } else {
            OpenClawChatTypography.bodyUIFont.capHeight
        }
        let format = UIGraphicsImageRendererFormat.preferred()
        let key = "\(name)/\(side)/\(format.scale)" as NSString
        let image: UIImage
        if let cached = self.cache.object(forKey: key) {
            image = cached
        } else if let vector = UIImage(named: name, in: .module, compatibleWith: nil) {
            let size = CGSize(width: side, height: side)
            image = UIGraphicsImageRenderer(size: size, format: format).image { _ in
                vector.draw(in: CGRect(origin: .zero, size: size))
            }.withBaselineOffset(fromBottom: 0).withRenderingMode(.alwaysTemplate)
            self.cache.setObject(image, forKey: key)
        } else {
            return Text(Image(systemName: "link")).foregroundStyle(.tint)
        }
        return Text(Image(uiImage: image)).foregroundStyle(.tint)
    }

    /// Exact filename overrides and extension families from ui/src/components/file-kind.ts.
    static func fileAsset(for path: String) -> String {
        let name = path.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last?.lowercased() ?? ""
        switch name {
        case "skill.md": return "inline-skill"
        case "bun.lock", "package-lock.json", "package.json", "pnpm-lock.yaml", "yarn.lock": return "inline-package"
        default: break
        }
        switch (name as NSString).pathExtension {
        case "astro", "jsx", "svelte", "tsx", "vue": return "inline-component"
        case "cfg", "conf", "ini", "json", "jsonc", "lock", "plist", "proto", "toml", "xml", "yaml", "yml":
            return "inline-data"
        case "avif", "gif", "ico", "jpeg", "jpg", "png", "svg", "webp": return "inline-image"
        case "markdown", "md", "mdx": return "inline-markdown"
        case "bash", "fish", "sh", "zsh": return "inline-shell"
        case "c", "cc", "cjs", "cpp", "cs", "css", "cts", "go", "h", "hpp", "htm", "html", "java", "js", "kt", "kts",
             "less", "mjs", "mts", "php", "py", "rb", "rs", "scss", "sql", "swift", "ts": return "inline-code"
        default: return "inline-file"
        }
    }
}
#endif
