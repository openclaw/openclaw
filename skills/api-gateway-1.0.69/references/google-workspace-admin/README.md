# Google Workspace Admin Routing Reference

**App name:** `google-workspace-admin`
**Base URL proxied:** `admin.googleapis.com`

## API Path Pattern

```
/google-workspace-admin/admin/directory/v1/{endpoint}
```

## Common Endpoints

### Users

#### List Users

```bash
GET /google-workspace-admin/admin/directory/v1/users?customer=my_customer&maxResults=100
```

With search query:

```bash
GET /google-workspace-admin/admin/directory/v1/users?customer=my_customer&query=email:john*
```

#### Get User

```bash
GET /google-workspace-admin/admin/directory/v1/users/{userKey}
```

`userKey` can be the user's primary email or unique user ID.

#### Create User

```bash
POST /google-workspace-admin/admin/directory/v1/users
Content-Type: application/json

{
  "primaryEmail": "newuser@example.com",
  "name": {
    "givenName": "Jane",
    "familyName": "Smith"
  },
  "password": "temporaryPassword123!",
  "changePasswordAtNextLogin": true,
  "orgUnitPath": "/Engineering"
}
```

#### Update User

```bash
PUT /google-workspace-admin/admin/directory/v1/users/{userKey}
Content-Type: application/json

{
  "name": {
    "givenName": "Jane",
    "familyName": "Smith-Johnson"
  },
  "suspended": false
}
```

#### Patch User (partial update)

```bash
PATCH /google-workspace-admin/admin/directory/v1/users/{userKey}
Content-Type: application/json

{
  "suspended": true
}
```

#### Delete User

```bash
DELETE /google-workspace-admin/admin/directory/v1/users/{userKey}
```

#### Make User Admin

```bash
POST /google-workspace-admin/admin/directory/v1/users/{userKey}/makeAdmin
Content-Type: application/json

{
  "status": true
}
```

### Groups

#### List Groups

```bash
GET /google-workspace-admin/admin/directory/v1/groups?customer=my_customer
```

#### Get Group

```bash
GET /google-workspace-admin/admin/directory/v1/groups/{groupKey}
```

#### Create Group

```bash
POST /google-workspace-admin/admin/directory/v1/groups
Content-Type: application/json

{
  "email": "engineering@example.com",
  "name": "Engineering Team",
  "description": "All engineering staff"
}
```

#### Update Group

```bash
PUT /google-workspace-admin/admin/directory/v1/groups/{groupKey}
Content-Type: application/json

{
  "name": "Engineering Department",
  "description": "Updated description"
}
```

#### Delete Group

```bash
DELETE /google-workspace-admin/admin/directory/v1/groups/{groupKey}
```

### Group Members

#### List Members

```bash
GET /google-workspace-admin/admin/directory/v1/groups/{groupKey}/members
```

#### Add Member

```bash
POST /google-workspace-admin/admin/directory/v1/groups/{groupKey}/members
Content-Type: application/json

{
  "email": "user@example.com",
  "role": "MEMBER"
}
```

Roles: `OWNER`, `MANAGER`, `MEMBER`

#### Update Member Role

```bash
PATCH /google-workspace-admin/admin/directory/v1/groups/{groupKey}/members/{memberKey}
Content-Type: application/json

{
  "role": "MANAGER"
}
```

#### Remove Member

```bash
DELETE /google-workspace-admin/admin/directory/v1/groups/{groupKey}/members/{memberKey}
```

### Organizational Units

#### List Org Units

```bash
GET /google-workspace-admin/admin/directory/v1/customer/my_customer/orgunits
```

#### Get Org Unit

```bash
GET /google-workspace-admin/admin/directory/v1/customer/my_customer/orgunits/{orgUnitPath}
```

#### Create Org Unit

```bash
POST /google-workspace-admin/admin/directory/v1/customer/my_customer/orgunits
Content-Type: application/json

{
  "name": "Engineering",
  "parentOrgUnitPath": "/",
  "description": "Engineering department"
}
```

#### Delete Org Unit

```bash
DELETE /google-workspace-admin/admin/directory/v1/customer/my_customer/orgunits/{orgUnitPath}
```

### Domains

#### List Domains

```bash
GET /google-workspace-admin/admin/directory/v1/customer/my_customer/domains
```

#### Get Domain

```bash
GET /google-workspace-admin/admin/directory/v1/customer/my_customer/domains/{domainName}
```

### Roles

#### List Roles

```bash
GET /google-workspace-admin/admin/directory/v1/customer/my_customer/roles
```

#### List Role Assignments

```bash
GET /google-workspace-admin/admin/directory/v1/customer/my_customer/roleassignments
```

#### Create Role Assignment

```bash
POST /google-workspace-admin/admin/directory/v1/customer/my_customer/roleassignments
Content-Type: application/json

{
  "roleId": "123456789",
  "assignedTo": "user_id",
  "scopeType": "CUSTOMER"
}
```

## Notes

- Use `my_customer` as the customer ID for your own domain
- User keys can be primary email or unique user ID
- Group keys can be group email or unique group ID
- Org unit paths start with `/` (e.g., `/Engineering/Frontend`)
- Admin privileges are required for most operations
- Password must meet Google's complexity requirements
