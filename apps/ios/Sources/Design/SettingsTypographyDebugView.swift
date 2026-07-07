#if DEBUG
import SwiftUI

struct SettingsTypographyDebugView: View {
    private let comparisonText = "Home Network"
    private let detailText = "LAN or Tailscale host"
    private let largeGlyphText = "Hamburgefons"
    private let glyphText = "Hamburgefonstiv 012345"
    private let smallGlyphText = "Il1 O0 ag Q&"

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 18) {
                self.largeGlyphComparison
                self.productionRowComparison
                self.guidelineTokens
                self.hardCodedBaselines
                self.smallControlComparison
            }
            .padding(.horizontal, OpenClawProMetric.pagePadding)
            .padding(.vertical, 18)
        }
        .font(OpenClawType.body)
        .background(OpenClawProBackground())
    }

    private var largeGlyphComparison: some View {
        self.debugSection("Large Glyph Comparison") {
            self.glyphSample(
                "Guideline title1",
                detail: "OpenClawType.title1 - Red Hat Display",
                font: OpenClawType.title1,
                displayText: self.largeGlyphText)
            self.glyphSample(
                "Guideline title3",
                detail: "OpenClawType.title3SemiBold - Red Hat Display",
                font: OpenClawType.title3SemiBold,
                displayText: self.largeGlyphText)
            self.glyphSample(
                "Guideline row",
                detail: "OpenClawType.subheadMedium - Inter",
                font: OpenClawType.subheadMedium,
                displayText: self.glyphText)
            self.glyphSample(
                "Hard-coded SF Pro",
                detail: "Font.system 34 semibold",
                font: .system(size: 34, weight: .semibold, design: .default),
                displayText: self.largeGlyphText)
            self.glyphSample(
                "Hard-coded Red Hat",
                detail: "RedHatDisplay-Regular 34 semibold",
                font: .custom("RedHatDisplay-Regular", size: 34, relativeTo: .largeTitle).weight(.semibold),
                displayText: self.largeGlyphText)
            self.glyphSample(
                "Hard-coded Inter",
                detail: "Inter-Regular 34 medium",
                font: .custom("Inter-Regular", size: 34, relativeTo: .largeTitle).weight(.medium),
                displayText: self.largeGlyphText)
        }
    }

    private var productionRowComparison: some View {
        self.debugSection("Production Row Comparison") {
            self.sampleRow(
                title: "Guideline row title",
                detail: "OpenClawType.subheadSemiBold",
                titleFont: OpenClawType.subheadSemiBold,
                detailFont: OpenClawType.captionMedium)
            self.sampleRow(
                title: "Guideline inactive/detail",
                detail: "OpenClawType.subheadMedium",
                titleFont: OpenClawType.subheadMedium,
                detailFont: OpenClawType.captionMedium)
            self.sampleRow(
                title: "Hard-coded SF Pro",
                detail: "Font.system 15 semibold",
                titleFont: .system(size: 15, weight: .semibold, design: .default),
                detailFont: .system(size: 12, weight: .medium, design: .default))
            self.sampleRow(
                title: "Hard-coded Inter",
                detail: "Inter-Regular 15 medium",
                titleFont: .custom("Inter-Regular", size: 15, relativeTo: .subheadline).weight(.medium),
                detailFont: .custom("Inter-Regular", size: 12, relativeTo: .caption).weight(.medium))
        }
    }

    private var guidelineTokens: some View {
        self.debugSection("Guideline Tokens") {
            self.fontSample("title2SemiBold", detail: "Red Hat Display 28 / 650", font: OpenClawType.title2SemiBold)
            self.fontSample("title3SemiBold", detail: "Red Hat Display 22 / 650", font: OpenClawType.title3SemiBold)
            self.fontSample("headline", detail: "Red Hat Display 17 / 650", font: OpenClawType.headline)
            self.fontSample("body", detail: "Inter 17 / 400", font: OpenClawType.body)
            self.fontSample("subhead", detail: "Inter 15 / 400", font: OpenClawType.subhead)
            self.fontSample("subheadMedium", detail: "Inter 15 / 500", font: OpenClawType.subheadMedium)
            self.fontSample("subheadSemiBold", detail: "Red Hat Display 15 / 650", font: OpenClawType.subheadSemiBold)
            self.fontSample("caption", detail: "Inter 12 / 400", font: OpenClawType.caption)
            self.fontSample("captionMedium", detail: "Inter 12 / 500", font: OpenClawType.captionMedium)
            self.fontSample("captionSemiBold", detail: "Inter 12 / 600", font: OpenClawType.captionSemiBold)
            self.fontSample("monoSmallMedium", detail: "JetBrains Mono 12 / medium", font: OpenClawType.monoSmallMedium)
        }
    }

    private var hardCodedBaselines: some View {
        self.debugSection("Hard-Coded Baselines") {
            self.fontSample(
                "SF Pro regular",
                detail: "Font.system 15 regular",
                font: .system(size: 15, weight: .regular, design: .default))
            self.fontSample(
                "SF Pro medium",
                detail: "Font.system 15 medium",
                font: .system(size: 15, weight: .medium, design: .default))
            self.fontSample(
                "SF Pro semibold",
                detail: "Font.system 15 semibold",
                font: .system(size: 15, weight: .semibold, design: .default))
            self.fontSample(
                "SF Rounded medium",
                detail: "Font.system 15 medium rounded",
                font: .system(size: 15, weight: .medium, design: .rounded))
            self.fontSample(
                "SF Serif medium",
                detail: "Font.system 15 medium serif",
                font: .system(size: 15, weight: .medium, design: .serif))
            self.fontSample(
                "Red Hat hard-coded",
                detail: "RedHatDisplay-Regular 15 semibold",
                font: .custom("RedHatDisplay-Regular", size: 15, relativeTo: .subheadline).weight(.semibold))
            self.fontSample(
                "Inter hard-coded",
                detail: "Inter-Regular 15 medium",
                font: .custom("Inter-Regular", size: 15, relativeTo: .subheadline).weight(.medium))
            self.fontSample(
                "JetBrains hard-coded",
                detail: "JetBrainsMono-Regular 12",
                font: .custom("JetBrainsMono-Regular", size: 12, relativeTo: .caption))
        }
    }

    private var smallControlComparison: some View {
        self.debugSection("Small Controls") {
            self.pillComparison("Guideline captionMedium", font: OpenClawType.captionMedium)
            self.pillComparison("Guideline captionSemiBold", font: OpenClawType.captionSemiBold)
            self.pillComparison("SF Pro caption medium", font: .system(size: 12, weight: .medium, design: .default))
            self.pillComparison(
                "Inter caption medium",
                font: .custom("Inter-Regular", size: 12, relativeTo: .caption).weight(.medium))
        }
    }

    private func debugSection(
        _ title: String,
        @ViewBuilder content: () -> some View) -> some View
    {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(OpenClawType.captionSemiBold)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 4)
            VStack(alignment: .leading, spacing: 14) {
                content()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .background {
                RoundedRectangle(cornerRadius: OpenClawProMetric.cardRadius, style: .continuous)
                    .fill(.background)
            }
        }
    }

    private func sampleRow(
        title: String,
        detail: String,
        titleFont: Font,
        detailFont: Font) -> some View
    {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(OpenClawType.captionMedium)
                .foregroundStyle(.secondary)
            HStack(spacing: 12) {
                Image(systemName: "house.fill")
                    .font(OpenClawType.captionBold)
                    .foregroundStyle(.white)
                    .frame(width: 30, height: 30)
                    .background {
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .fill(OpenClawBrand.accent)
                    }
                VStack(alignment: .leading, spacing: 2) {
                    Text(self.comparisonText)
                        .font(titleFont)
                    Text(self.detailText)
                        .font(detailFont)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
            Text(detail)
                .font(OpenClawType.caption2Medium)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
    }

    private func glyphSample(_ title: String, detail: String, font: Font, displayText: String) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title)
                .font(OpenClawType.captionSemiBold)
                .foregroundStyle(.secondary)
            Text(displayText)
                .font(font)
                .lineLimit(1)
                .minimumScaleFactor(0.72)
            Text(self.smallGlyphText)
                .font(font)
                .lineLimit(1)
            Text(detail)
                .font(OpenClawType.caption2Medium)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 6)
    }

    private func fontSample(_ title: String, detail: String, font: Font) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("OpenClaw")
                .font(font)
            Text("\(title) - \(detail)")
                .font(OpenClawType.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 3)
    }

    private func pillComparison(_ title: String, font: Font) -> some View {
        HStack(spacing: 12) {
            Text("Unencrypted")
                .font(font)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 7)
                .background(.thinMaterial, in: Capsule())
            Text("Secure (TLS)")
                .font(font)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 7)
                .background(.regularMaterial, in: Capsule())
        }
        .overlay(alignment: .topLeading) {
            Text(title)
                .font(OpenClawType.caption2Medium)
                .foregroundStyle(.secondary)
                .offset(y: -18)
        }
        .padding(.top, 18)
        .padding(.bottom, 4)
    }
}

#Preview("Typography Debug") {
    NavigationStack {
        SettingsTypographyDebugView()
            .navigationTitle("Typography Debug")
    }
}
#endif
