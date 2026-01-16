import SwiftUI

struct ConfigSchemaForm: View {
    @Bindable var store: ChannelsStore
    let schema: ConfigSchemaNode
    let path: ConfigPath

    var body: some View {
        self.renderNode(schema, path: path)
    }

    @ViewBuilder
    private func renderNode(_ schema: ConfigSchemaNode, path: ConfigPath) -> some View {
        let value = store.configValue(at: path)
        let label = hintForPath(path, hints: store.configUiHints)?.label ?? schema.title
        let help = hintForPath(path, hints: store.configUiHints)?.help ?? schema.description

        switch schema.schemaType {
        case "object":
            VStack(alignment: .leading, spacing: 12) {
                if let label {
                    Text(label)
                        .font(.callout.weight(.semibold))
                }
                if let help {
                    Text(help)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                let properties = schema.properties
                let sortedKeys = properties.keys.sorted { lhs, rhs in
                    let orderA = hintForPath(path + [.key(lhs)], hints: store.configUiHints)?.order ?? 0
                    let orderB = hintForPath(path + [.key(rhs)], hints: store.configUiHints)?.order ?? 0
                    if orderA != orderB { return orderA < orderB }
                    return lhs < rhs
                }
                ForEach(sortedKeys, id: \ .self) { key in
                    if let child = properties[key] {
                        self.renderNode(child, path: path + [.key(key)])
                    }
                }
                if schema.allowsAdditionalProperties {
                    self.renderAdditionalProperties(schema, path: path, value: value)
                }
            }
        case "array":
            self.renderArray(schema, path: path, value: value, label: label, help: help)
        case "boolean":
            Toggle(isOn: self.boolBinding(path)) {
                if let label { Text(label) } else { Text("Enabled") }
            }
            .help(help ?? "")
        case "number", "integer":
            self.renderNumberField(schema, path: path, label: label, help: help)
        case "string":
            self.renderStringField(schema, path: path, label: label, help: help)
        default:
            VStack(alignment: .leading, spacing: 6) {
                if let label { Text(label).font(.callout.weight(.semibold)) }
                Text("Unsupported field type.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private func renderStringField(
        _ schema: ConfigSchemaNode,
        path: ConfigPath,
        label: String?,
        help: String?) -> some View
    {
        let hint = hintForPath(path, hints: store.configUiHints)
        let placeholder = hint?.placeholder ?? ""
        let sensitive = hint?.sensitive ?? false
        VStack(alignment: .leading, spacing: 6) {
            if let label { Text(label).font(.callout.weight(.semibold)) }
            if let help {
                Text(help)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let options = schema.enumValues {
                Picker("", selection: self.enumBinding(path, options: options)) {
                    Text("Select…").tag(-1)
                    ForEach(options.indices, id: \ .self) { index in
                        Text(String(describing: options[index])).tag(index)
                    }
                }
                .pickerStyle(.menu)
            } else if sensitive {
                SecureField(placeholder, text: self.stringBinding(path))
                    .textFieldStyle(.roundedBorder)
            } else {
                TextField(placeholder, text: self.stringBinding(path))
                    .textFieldStyle(.roundedBorder)
            }
        }
    }

    @ViewBuilder
    private func renderNumberField(
        _ schema: ConfigSchemaNode,
        path: ConfigPath,
        label: String?,
        help: String?) -> some View
    {
        VStack(alignment: .leading, spacing: 6) {
            if let label { Text(label).font(.callout.weight(.semibold)) }
            if let help {
                Text(help)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            TextField("", text: self.numberBinding(path, isInteger: schema.schemaType == "integer"))
                .textFieldStyle(.roundedBorder)
        }
    }

    @ViewBuilder
    private func renderArray(
        _ schema: ConfigSchemaNode,
        path: ConfigPath,
        value: Any?,
        label: String?,
        help: String?) -> some View
    {
        let items = value as? [Any] ?? []
        let itemSchema = schema.items
        VStack(alignment: .leading, spacing: 10) {
            if let label { Text(label).font(.callout.weight(.semibold)) }
            if let help {
                Text(help)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            ForEach(items.indices, id: \ .self) { index in
                HStack(alignment: .top, spacing: 8) {
                    if let itemSchema {
                        self.renderNode(itemSchema, path: path + [.index(index)])
                    } else {
                        Text(String(describing: items[index]))
                    }
                    Button("Remove") {
                        var next = items
                        next.remove(at: index)
                        store.updateConfigValue(path: path, value: next)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                }
            }
            Button("Add") {
                var next = items
                if let itemSchema {
                    next.append(itemSchema.defaultValue)
                } else {
                    next.append("")
                }
                store.updateConfigValue(path: path, value: next)
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
    }

    @ViewBuilder
    private func renderAdditionalProperties(
        _ schema: ConfigSchemaNode,
        path: ConfigPath,
        value: Any?) -> some View
    {
        guard let additionalSchema = schema.additionalProperties else { return }
        let dict = value as? [String: Any] ?? [:]
        let reserved = Set(schema.properties.keys)
        let extras = dict.keys.filter { !reserved.contains($0) }.sorted()

        VStack(alignment: .leading, spacing: 8) {
            Text("Extra entries")
                .font(.callout.weight(.semibold))
            if extras.isEmpty {
                Text("No extra entries yet.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(extras, id: \ .self) { key in
                    let itemPath: ConfigPath = path + [.key(key)]
                    HStack(alignment: .top, spacing: 8) {
                        TextField("Key", text: self.mapKeyBinding(path: path, key: key))
                            .textFieldStyle(.roundedBorder)
                            .frame(width: 160)
                        self.renderNode(additionalSchema, path: itemPath)
                        Button("Remove") {
                            var next = dict
                            next.removeValue(forKey: key)
                            store.updateConfigValue(path: path, value: next)
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                    }
                }
            }
            Button("Add") {
                var next = dict
                var index = 1
                var key = "new-\(index)"
                while next[key] != nil {
                    index += 1
                    key = "new-\(index)"
                }
                next[key] = additionalSchema.defaultValue
                store.updateConfigValue(path: path, value: next)
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
    }

    private func stringBinding(_ path: ConfigPath) -> Binding<String> {
        Binding(
            get: {
                store.configValue(at: path) as? String ?? ""
            },
            set: { newValue in
                let trimmed = newValue.trimmingCharacters(in: .whitespacesAndNewlines)
                store.updateConfigValue(path: path, value: trimmed.isEmpty ? nil : trimmed)
            }
        )
    }

    private func boolBinding(_ path: ConfigPath) -> Binding<Bool> {
        Binding(
            get: {
                store.configValue(at: path) as? Bool ?? false
            },
            set: { newValue in
                store.updateConfigValue(path: path, value: newValue)
            }
        )
    }

    private func numberBinding(_ path: ConfigPath, isInteger: Bool) -> Binding<String> {
        Binding(
            get: {
                guard let value = store.configValue(at: path) else { return "" }
                return String(describing: value)
            },
            set: { newValue in
                let trimmed = newValue.trimmingCharacters(in: .whitespacesAndNewlines)
                if trimmed.isEmpty {
                    store.updateConfigValue(path: path, value: nil)
                } else if let value = Double(trimmed) {
                    store.updateConfigValue(path: path, value: isInteger ? Int(value) : value)
                }
            }
        )
    }

    private func enumBinding(_ path: ConfigPath, options: [Any]) -> Binding<Int> {
        Binding(
            get: {
                guard let value = store.configValue(at: path) else { return -1 }
                return options.firstIndex { option in
                    String(describing: option) == String(describing: value)
                } ?? -1
            },
            set: { index in
                guard index >= 0, index < options.count else {
                    store.updateConfigValue(path: path, value: nil)
                    return
                }
                store.updateConfigValue(path: path, value: options[index])
            }
        )
    }

    private func mapKeyBinding(path: ConfigPath, key: String) -> Binding<String> {
        Binding(
            get: { key },
            set: { newValue in
                let trimmed = newValue.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !trimmed.isEmpty else { return }
                guard trimmed != key else { return }
                let current = store.configValue(at: path) as? [String: Any] ?? [:]
                guard current[trimmed] == nil else { return }
                var next = current
                next[trimmed] = current[key]
                next.removeValue(forKey: key)
                store.updateConfigValue(path: path, value: next)
            }
        )
    }
}

struct ChannelConfigForm: View {
    @Bindable var store: ChannelsStore
    let channelId: String

    var body: some View {
        if store.configSchemaLoading {
            ProgressView().controlSize(.small)
        } else if let schema = store.channelConfigSchema(for: channelId) {
            ConfigSchemaForm(store: store, schema: schema, path: [.key("channels"), .key(channelId)])
        } else {
            Text("Schema unavailable for this channel.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}
