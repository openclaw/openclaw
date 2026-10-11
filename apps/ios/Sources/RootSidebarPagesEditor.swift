import SwiftUI

/// The native customization sheet edits the same mixed order as the drawer.
struct RootSidebarPagesEditor: View {
    let destinations: [RootTabs.SidebarDestination]
    let pinnedPages: [RootTabs.SidebarDestination]
    let onSelect: (RootTabs.SidebarDestination) -> Void
    let onTogglePin: (RootTabs.SidebarDestination) -> Void
    let onReset: () -> Void

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(self.destinations) { destination in
                        Toggle(isOn: Binding(
                            get: { self.pinnedPages.contains(destination) },
                            set: { _ in self.onTogglePin(destination) }))
                        {
                            Label {
                                Text(destination.sidebarTitle).font(OpenClawType.subheadSemiBold)
                            } icon: { Image(systemName: destination.systemImage) }
                        }
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                        .contextMenu {
                            Button { self.onSelect(destination) } label: {
                                Label {
                                    Text("Open").font(OpenClawType.subhead)
                                } icon: { Image(systemName: "arrow.up.right") }
                            }
                        }
                    }
                } footer: {
                    Text("Pinned pages stay in the sidebar. Home is always shown.")
                        .font(OpenClawType.caption)
                }
                Section {
                    Button(action: self.onReset) {
                        Label {
                            Text("Reset Sidebar").font(OpenClawType.subheadSemiBold)
                        } icon: { Image(systemName: "arrow.counterclockwise") }
                    }
                } footer: {
                    Text("Reset restores default pages and keeps pinned conversations.")
                        .font(OpenClawType.caption)
                }
            }
            .navigationTitle(String(localized: "Customize Sidebar"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button { self.dismiss() } label: {
                        Text("Done").font(OpenClawType.subheadSemiBold)
                    }
                }
            }
        }
        .openClawSheetChrome()
    }
}
