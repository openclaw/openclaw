# Google Contacts Routing Reference

**App name:** `google-contacts`
**Base URL proxied:** `people.googleapis.com`

## API Path Pattern

```
/google-contacts/v1/{endpoint}
```

## Common Endpoints

### List Contacts

```bash
GET /google-contacts/v1/people/me/connections?personFields=names,emailAddresses,phoneNumbers&pageSize=100
```

### Get Contact

```bash
GET /google-contacts/v1/people/{resourceName}?personFields=names,emailAddresses,phoneNumbers
```

Example: `GET /google-contacts/v1/people/c1234567890?personFields=names,emailAddresses`

### Create Contact

```bash
POST /google-contacts/v1/people:createContact
Content-Type: application/json

{
  "names": [{"givenName": "John", "familyName": "Doe"}],
  "emailAddresses": [{"value": "john@example.com"}],
  "phoneNumbers": [{"value": "+1-555-0123"}]
}
```

### Update Contact

```bash
PATCH /google-contacts/v1/people/{resourceName}:updateContact?updatePersonFields=names,emailAddresses
Content-Type: application/json

{
  "etag": "%EgcBAgkLLjc9...",
  "names": [{"givenName": "John", "familyName": "Smith"}]
}
```

### Delete Contact

```bash
DELETE /google-contacts/v1/people/{resourceName}:deleteContact
```

### Batch Get Contacts

```bash
GET /google-contacts/v1/people:batchGet?resourceNames=people/c123&resourceNames=people/c456&personFields=names
```

### Batch Create Contacts

```bash
POST /google-contacts/v1/people:batchCreateContacts
Content-Type: application/json

{
  "contacts": [{"contactPerson": {"names": [{"givenName": "Alice"}]}}],
  "readMask": "names"
}
```

### Batch Delete Contacts

```bash
POST /google-contacts/v1/people:batchDeleteContacts
Content-Type: application/json

{
  "resourceNames": ["people/c123", "people/c456"]
}
```

### Search Contacts

```bash
GET /google-contacts/v1/people:searchContacts?query=John&readMask=names,emailAddresses
```

### List Contact Groups

```bash
GET /google-contacts/v1/contactGroups?pageSize=100
```

### Get Contact Group

```bash
GET /google-contacts/v1/contactGroups/{resourceName}?maxMembers=100
```

### Create Contact Group

```bash
POST /google-contacts/v1/contactGroups
Content-Type: application/json

{
  "contactGroup": {"name": "Work Contacts"}
}
```

### Delete Contact Group

```bash
DELETE /google-contacts/v1/contactGroups/{resourceName}?deleteContacts=false
```

### Modify Group Members

```bash
POST /google-contacts/v1/contactGroups/{resourceName}/members:modify
Content-Type: application/json

{
  "resourceNamesToAdd": ["people/c123"],
  "resourceNamesToRemove": ["people/c456"]
}
```

### List Other Contacts

```bash
GET /google-contacts/v1/otherContacts?readMask=names,emailAddresses&pageSize=100
```

## Notes

- Resource names for contacts: `people/c{id}` (e.g., `people/c1234567890`)
- Resource names for groups: `contactGroups/{id}` (e.g., `contactGroups/starred`)
- System groups: `starred`, `friends`, `family`, `coworkers`, `myContacts`, `all`, `blocked`
- `personFields` parameter is required for most read operations
- Include `etag` when updating to prevent concurrent modification issues
- Pagination uses `pageToken` parameter

## Resources

- [Google People API Overview](https://developers.google.com/people/api/rest)
- [People Resource](https://developers.google.com/people/api/rest/v1/people)
- [Contact Groups Resource](https://developers.google.com/people/api/rest/v1/contactGroups)
