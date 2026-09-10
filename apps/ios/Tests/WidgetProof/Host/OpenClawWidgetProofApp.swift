import SwiftUI

@main
struct OpenClawWidgetProofApp: App {
    @State private var index = 0

    var body: some Scene {
        WindowGroup {
            let fixture = OpenClawWidgetProofFixtures.all[self.index]
            VStack(spacing: 8) {
                ScrollView([.horizontal, .vertical]) {
                    OpenClawStatusWidgetContent(presentation: fixture.presentation, family: fixture.family.value)
                        .environment(\.colorScheme, fixture.appearance.scheme)
                        .environment(\.dynamicTypeSize, fixture.textSize.value)
                        .environment(\.locale, OpenClawWidgetProofFixtures.locale)
                        .environment(\.timeZone, OpenClawWidgetProofFixtures.timeZone)
                        .frame(width: fixture.family.size.width, height: fixture.family.size.height)
                        .padding(8)
                        .accessibilityIdentifier(fixture.id)
                        .id(fixture.id)
                }
                .accessibilityIdentifier("widget-proof-viewport")
                HStack {
                    Text(verbatim: Bundle.main.object(forInfoDictionaryKey: "OpenClawGitCommit") as? String ?? "")
                        .font(OpenClawActivityType.caption)
                        .accessibilityIdentifier("widget-proof-revision")
                    Spacer()
                    Button {
                        self.index += 1
                    } label: {
                        Text("Next")
                            .font(OpenClawActivityType.caption)
                    }
                    .accessibilityIdentifier("widget-proof-next")
                    .disabled(self.index == OpenClawWidgetProofFixtures.all.count - 1)
                }
            }
            .padding(8)
            .preferredColorScheme(fixture.appearance.scheme)
        }
    }
}
