import OpenClawProtocol

/// Reconstruct before bounded subscriber queues can discard intermediate presence updates.
struct GatewayPresenceProjection {
    private var version: Int?
    private var rows: [String: AnyCodable] = [:]

    mutating func reset() {
        self.version = nil
        self.rows.removeAll()
    }

    /// A missing baseline uses the channel's existing reconnect/resynchronization path.
    mutating func project(_ event: EventFrame) -> EventFrame? {
        guard event.event == "presence" else { return event }
        guard let payload = event.payload?.dictionaryValue else { return nil }
        // Released Gateways without delta support still send full rosters.
        if payload["reset"] == nil, payload["base"] == nil, payload["presence"]?.arrayValue != nil {
            self.reset()
            return event
        }
        guard let version = payload["version"]?.intValue else { return nil }
        let order: [String]
        var next: [String: AnyCodable]
        if payload["reset"]?.boolValue == true {
            guard let presence = payload["presence"]?.arrayValue,
                  let keys = Self.strings(payload["keys"]),
                  keys.count == presence.count, Set(keys).count == keys.count
            else { return nil }
            order = keys
            next = Dictionary(uniqueKeysWithValues: zip(keys, presence))
        } else {
            guard let base = payload["base"]?.intValue, base == self.version,
                  let upsert = payload["upsert"]?.arrayValue,
                  let remove = Self.strings(payload["remove"]),
                  let keys = Self.strings(payload["order"])
            else { return nil }
            next = self.rows
            for key in remove {
                next.removeValue(forKey: key)
            }
            for value in upsert {
                guard let entry = value.dictionaryValue, let key = entry["key"]?.stringValue else { return nil }
                if let presence = entry["presence"], presence.dictionaryValue != nil {
                    next[key] = presence
                } else {
                    guard var row = next[key]?.dictionaryValue,
                          let set = entry["set"]?.dictionaryValue,
                          let unset = Self.strings(entry["unset"])
                    else { return nil }
                    row.merge(set) { _, new in new }
                    for field in unset {
                        row.removeValue(forKey: field)
                    }
                    next[key] = AnyCodable(row)
                }
            }
            guard keys.count == next.count, Set(keys).count == next.count,
                  keys.allSatisfy({ next[$0] != nil })
            else { return nil }
            order = keys
        }
        self.version = version
        self.rows = next
        return EventFrame(
            type: event.type,
            event: event.event,
            payload: AnyCodable(["presence": AnyCodable(order.compactMap { next[$0] })]),
            seq: event.seq,
            stateversion: event.stateversion,
            recipientprofileid: event.recipientprofileid)
    }

    private static func strings(_ value: AnyCodable?) -> [String]? {
        guard let values = value?.arrayValue else { return nil }
        let strings = values.compactMap(\.stringValue)
        return strings.count == values.count ? strings : nil
    }
}
