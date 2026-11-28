import SwiftUI

struct NativeUsagePeriodControl: View {
    @Binding var period: NativeUsageScreen.Period
    let dates: ClosedRange<Date>
    let displayedDates: ClosedRange<Date>
    let isUpdating: Bool
    let applyCustom: (ClosedRange<Date>) -> Void
    @State private var editingDates = false

    var body: some View {
        Section {
            HStack(spacing: 12) {
                Menu {
                    ForEach(NativeUsageScreen.Period.allCases) { option in
                        Button {
                            if option == .custom { self.editingDates = true } else { self.period = option }
                        } label: {
                            let title: LocalizedStringKey = option == .custom ? "Custom range…" : option.title
                            if option == self.period {
                                Label { Text(title).font(OpenClawType.body) } icon: { Image(systemName: "checkmark") }
                            } else {
                                Text(title).font(OpenClawType.body)
                            }
                        }
                    }
                } label: {
                    HStack(spacing: 8) {
                        Text(self.period.title).font(OpenClawType.subheadSemiBold)
                        Image(systemName: "chevron.down").font(OpenClawType.caption).accessibilityHidden(true)
                    }
                    .foregroundStyle(.primary)
                }
                .menuOrder(.fixed)
                .menuIndicator(.hidden)
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
                .controlSize(.large)
                .accessibilityIdentifier("Usage.Period")
                if self.isUpdating {
                    ProgressView().controlSize(.small).accessibilityLabel(Text("Updating date range…"))
                }
                Spacer(minLength: 0)
            }
            .listRowInsets(EdgeInsets())
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
        } footer: {
            let interval = self.displayedDates.lowerBound..<self.displayedDates.upperBound
            Text(verbatim: interval.formatted(.interval.year().month(.abbreviated).day()) + " · " + TimeZone.current
                .identifier)
                .font(OpenClawType.caption)
        }
        .sheet(isPresented: self.$editingDates) {
            NativeUsageCustomDates(dates: self.dates, apply: self.applyCustom)
        }
    }
}

private struct NativeUsageCustomDates: View {
    @Environment(\.dismiss) private var dismiss
    @State private var start: Date
    @State private var end: Date
    let apply: (ClosedRange<Date>) -> Void

    init(dates: ClosedRange<Date>, apply: @escaping (ClosedRange<Date>) -> Void) {
        self._start = State(initialValue: dates.lowerBound)
        self._end = State(initialValue: dates.upperBound)
        self.apply = apply
    }

    var body: some View {
        NavigationStack {
            Form {
                DatePicker(selection: self.$start, in: ...self.end, displayedComponents: .date) {
                    Text("Start date").font(OpenClawType.body)
                }
                DatePicker(
                    selection: self.$end,
                    in: self.start...max(self.start, Date.now),
                    displayedComponents: .date)
                {
                    Text("End date").font(OpenClawType.body)
                }
            }
            .navigationTitle(Text("Custom range"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { self.dismiss() } label: { Text("Cancel").font(OpenClawType.subhead) }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        self.apply(self.start...self.end)
                        self.dismiss()
                    } label: { Text("Apply").font(OpenClawType.subheadSemiBold) }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
}
