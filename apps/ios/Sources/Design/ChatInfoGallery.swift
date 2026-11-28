import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
import SwiftUI

/// Every artifact of the chat, newest first. Artifacts carry no date, so there are no period groups.
/// The catalog is one bounded reply; the grid and list are lazy, so only visible cells render or fetch.
struct ChatInfoGallery: View {
    enum Tab: Hashable { case media, files }

    let visit: ChatInfoVisit
    let items: [ArtifactSummary]
    @State private var tab = Tab.media
    @State private var requestedID: String?
    @Environment(\.colorScheme) private var colorScheme

    private var media: [ArtifactSummary] {
        self.items.filter { $0.type == "image" }
    }

    private var files: [ArtifactSummary] {
        self.items.filter { $0.type != "image" }
    }

    var body: some View {
        ScrollView(.vertical) {
            switch self.tab {
            case .media: self.grid
            case .files: self.list
            }
        }
        .safeAreaBar(edge: .top) {
            Picker(selection: self.$tab) {
                Text("Media").tag(Tab.media)
                Text("Files").tag(Tab.files)
            } label: { Text("Media and files") }
                .pickerStyle(.segmented).padding(.horizontal, 16).padding(.bottom, 8)
        }
        .scrollEdgeEffectStyle(.soft, for: .top)
        .background((self.colorScheme == .dark ? OpenClawBrand.canvas : OpenClawBrand.surfaceMuted).ignoresSafeArea())
        .navigationTitle(Text("Media and files"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackgroundVisibility(.hidden, for: .navigationBar)
        .modifier(ChatInfoArtifactViewer(visit: self.visit, items: self.items, requestedID: self.$requestedID))
    }

    @ViewBuilder private var grid: some View {
        if self.media.isEmpty {
            self.empty(String(localized: "No images yet"))
        } else {
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 3), count: 4), spacing: 3) {
                ForEach(self.media, id: \.id) { item in
                    ChatInfoMediaButton(
                        visit: self.visit, item: item, stripVisible: true, requestedID: self.$requestedID)
                        .aspectRatio(1, contentMode: .fit)
                }
            }.padding(.top, 8)
        }
    }

    @ViewBuilder private var list: some View {
        if self.files.isEmpty {
            self.empty(String(localized: "No files yet"))
        } else {
            LazyVStack(spacing: 0) {
                ForEach(self.files, id: \.id) { item in
                    if item.id != self.files.first?.id { Divider().padding(.leading, 70) }
                    self.row(item)
                }
            }
            .background(OpenClawBrand.surfaceRaised, in: .rect(cornerRadius: 24))
            .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 24)
        }
    }

    private func row(_ item: ArtifactSummary) -> some View {
        let supported = item.download["mode"]?.value as? String != "unsupported"
        return Button { self.requestedID = item.id } label: {
            HStack(spacing: 14) {
                Image(systemName: ChatInfoMedia.symbol(for: item)).font(OpenClawType.body)
                    .foregroundStyle(OpenClawBrand.textSecondary)
                    .frame(width: 40, height: 40).background(OpenClawBrand.selection, in: .rect(cornerRadius: 10))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 1) {
                    Text(verbatim: item.title).font(OpenClawType.subhead).lineLimit(1).truncationMode(.middle)
                    if let size = item.sizebytes {
                        Text(verbatim: ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file))
                            .font(OpenClawType.footnote).foregroundStyle(OpenClawBrand.textSecondary)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 16).padding(.vertical, 11).contentShape(.rect)
        }
        .buttonStyle(.plain).accessibilityElement(children: .combine)
        .accessibilityIdentifier("chat-info-gallery-file-" + item.id)
        .disabled(!supported || self.requestedID != nil)
    }

    private func empty(_ text: String) -> some View {
        Text(verbatim: text).font(OpenClawType.body).foregroundStyle(OpenClawBrand.textSecondary)
            .frame(maxWidth: .infinity).padding(.top, 48)
    }
}
