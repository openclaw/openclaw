import Contacts
import Foundation
import OpenClawKit

final class ContactsService: ContactsServicing {
    func search(params: OpenClawContactsSearchParams) async throws -> OpenClawContactsSearchPayload {
        let store = CNContactStore()
        let status = CNContactStore.authorizationStatus(for: .contacts)
        let authorized = await Self.ensureAuthorization(store: store, status: status)
        guard authorized else {
            throw NSError(domain: "Contacts", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "CONTACTS_PERMISSION_REQUIRED: grant Contacts permission",
            ])
        }

        let limit = max(1, min(params.limit ?? 25, 200))
        let keys: [CNKeyDescriptor] = [
            CNContactIdentifierKey as CNKeyDescriptor,
            CNContactGivenNameKey as CNKeyDescriptor,
            CNContactFamilyNameKey as CNKeyDescriptor,
            CNContactOrganizationNameKey as CNKeyDescriptor,
            CNContactPhoneNumbersKey as CNKeyDescriptor,
            CNContactEmailAddressesKey as CNKeyDescriptor,
        ]

        var contacts: [CNContact] = []
        if let query = params.query?.trimmingCharacters(in: .whitespacesAndNewlines), !query.isEmpty {
            let predicate = CNContact.predicateForContacts(matchingName: query)
            contacts = try store.unifiedContacts(matching: predicate, keysToFetch: keys)
        } else {
            let request = CNContactFetchRequest(keysToFetch: keys)
            try store.enumerateContacts(with: request) { contact, stop in
                contacts.append(contact)
                if contacts.count >= limit {
                    stop.pointee = true
                }
            }
        }

        let sliced = Array(contacts.prefix(limit))
        let payload = sliced.map { contact in
            OpenClawContactPayload(
                identifier: contact.identifier,
                displayName: CNContactFormatter.string(from: contact, style: .fullName)
                    ?? "\(contact.givenName) \(contact.familyName)".trimmingCharacters(in: .whitespacesAndNewlines),
                givenName: contact.givenName,
                familyName: contact.familyName,
                organizationName: contact.organizationName,
                phoneNumbers: contact.phoneNumbers.map { $0.value.stringValue },
                emails: contact.emailAddresses.map { String($0.value) })
        }

        return OpenClawContactsSearchPayload(contacts: payload)
    }

    private static func ensureAuthorization(store: CNContactStore, status: CNAuthorizationStatus) async -> Bool {
        switch status {
        case .authorized, .limited:
            return true
        case .notDetermined:
            return await withCheckedContinuation { cont in
                store.requestAccess(for: .contacts) { granted, _ in
                    cont.resume(returning: granted)
                }
            }
        case .restricted, .denied:
            return false
        @unknown default:
            return false
        }
    }
}
