import Foundation
import OpenClawKit

enum KeychainStore {
    static func loadString(service: String, account: String) -> String? {
        GenericPasswordKeychainStore.loadString(service: service, account: account)
    }

    static func saveString(_ value: String, service: String, account: String) -> Bool {
        GenericPasswordKeychainStore.saveString(value, service: service, account: account)
    }

    static func delete(service: String, account: String) -> Bool {
        GenericPasswordKeychainStore.delete(service: service, account: account)
    }
}
