# Dropbox Business Routing Reference

**App name:** `dropbox-business`
**Base URL proxied:** `api.dropboxapi.com`

## API Path Pattern

```
/dropbox-business/2/{endpoint}
```

**Note:** Dropbox Business API uses POST for almost all endpoints, including read operations. Request bodies should be JSON (use `null` for endpoints with no parameters).

## Team Information

### Get Team Info

```bash
POST /dropbox-business/2/team/get_info
Content-Type: application/json

null
```

### Get Team Features

```bash
POST /dropbox-business/2/team/features/get_values
Content-Type: application/json

{
  "features": [
    {".tag": "upload_api_rate_limit"},
    {".tag": "has_team_shared_dropbox"},
    {".tag": "has_team_file_events"},
    {".tag": "has_team_selective_sync"}
  ]
}
```

### Get Authenticated Admin

```bash
POST /dropbox-business/2/team/token/get_authenticated_admin
Content-Type: application/json

null
```

## Team Members

### List Members

```bash
POST /dropbox-business/2/team/members/list
Content-Type: application/json

{"limit": 100}
```

### List Members (V2) - Recommended

```bash
POST /dropbox-business/2/team/members/list_v2
Content-Type: application/json

{"limit": 100, "include_removed": false}
```

### Continue Listing Members

```bash
POST /dropbox-business/2/team/members/list/continue
Content-Type: application/json

{"cursor": "..."}
```

### Get Member Info

```bash
POST /dropbox-business/2/team/members/get_info
Content-Type: application/json

{"members": [{".tag": "email", "email": "user@company.com"}]}
```

### Get Member Info (V2) - Recommended

```bash
POST /dropbox-business/2/team/members/get_info_v2
Content-Type: application/json

{"members": [{".tag": "email", "email": "user@company.com"}]}
```

### Add Member

```bash
POST /dropbox-business/2/team/members/add
Content-Type: application/json

{
  "new_members": [{
    "member_email": "user@company.com",
    "member_given_name": "John",
    "member_surname": "Doe",
    "send_welcome_email": true
  }]
}
```

### Suspend Member

```bash
POST /dropbox-business/2/team/members/suspend
Content-Type: application/json

{"user": {".tag": "email", "email": "user@company.com"}, "wipe_data": false}
```

### Unsuspend Member

```bash
POST /dropbox-business/2/team/members/unsuspend
Content-Type: application/json

{"user": {".tag": "email", "email": "user@company.com"}}
```

### Remove Member

```bash
POST /dropbox-business/2/team/members/remove
Content-Type: application/json

{
  "user": {".tag": "email", "email": "user@company.com"},
  "wipe_data": true,
  "transfer_dest_id": {".tag": "email", "email": "admin@company.com"},
  "transfer_admin_id": {".tag": "email", "email": "admin@company.com"},
  "keep_account": false
}
```

### Send Welcome Email

```bash
POST /dropbox-business/2/team/members/send_welcome_email
Content-Type: application/json

{".tag": "email", "email": "pending@company.com"}
```

### Set Member Profile (V2)

```bash
POST /dropbox-business/2/team/members/set_profile_v2
Content-Type: application/json

{
  "user": {".tag": "team_member_id", "team_member_id": "dbmid:AAA..."},
  "new_given_name": "John",
  "new_surname": "Smith"
}
```

### Set Admin Permissions (V2)

```bash
POST /dropbox-business/2/team/members/set_admin_permissions_v2
Content-Type: application/json

{
  "user": {".tag": "email", "email": "user@company.com"},
  "new_roles": ["pid_dbtmr:..."]
}
```

### Delete Profile Photo (V2)

```bash
POST /dropbox-business/2/team/members/delete_profile_photo_v2
Content-Type: application/json

{"user": {".tag": "team_member_id", "team_member_id": "dbmid:AAA..."}}
```

## Secondary Emails

### Add Secondary Emails

```bash
POST /dropbox-business/2/team/members/secondary_emails/add
Content-Type: application/json

{
  "new_secondary_emails": [{
    "user": {".tag": "email", "email": "user@company.com"},
    "secondary_emails": ["alias@company.com"]
  }]
}
```

### Delete Secondary Emails

```bash
POST /dropbox-business/2/team/members/secondary_emails/delete
Content-Type: application/json

{
  "emails_to_delete": [{
    "user": {".tag": "email", "email": "user@company.com"},
    "secondary_emails": ["alias@company.com"]
  }]
}
```

### Resend Verification Emails

```bash
POST /dropbox-business/2/team/members/secondary_emails/resend_verification_emails
Content-Type: application/json

{
  "emails_to_resend": [{
    "user": {".tag": "email", "email": "user@company.com"},
    "secondary_emails": ["alias@company.com"]
  }]
}
```

## Groups

### List Groups

```bash
POST /dropbox-business/2/team/groups/list
Content-Type: application/json

{"limit": 100}
```

### Get Group Info

```bash
POST /dropbox-business/2/team/groups/get_info
Content-Type: application/json

{".tag": "group_ids", "group_ids": ["g:1d31f47b..."]}
```

### List Group Members

```bash
POST /dropbox-business/2/team/groups/members/list
Content-Type: application/json

{
  "group": {".tag": "group_id", "group_id": "g:1d31f47b..."},
  "limit": 100
}
```

### Create Group

```bash
POST /dropbox-business/2/team/groups/create
Content-Type: application/json

{
  "group_name": "Team Name",
  "group_management_type": {".tag": "company_managed"}
}
```

### Update Group

```bash
POST /dropbox-business/2/team/groups/update
Content-Type: application/json

{
  "group": {".tag": "group_id", "group_id": "g:1d31f47b..."},
  "new_group_name": "New Name"
}
```

### Add Members to Group

```bash
POST /dropbox-business/2/team/groups/members/add
Content-Type: application/json

{
  "group": {".tag": "group_id", "group_id": "g:1d31f47b..."},
  "members": [{"user": {".tag": "email", "email": "user@company.com"}, "access_type": {".tag": "member"}}],
  "return_members": true
}
```

### Remove Members from Group

```bash
POST /dropbox-business/2/team/groups/members/remove
Content-Type: application/json

{
  "group": {".tag": "group_id", "group_id": "g:1d31f47b..."},
  "users": [{".tag": "email", "email": "user@company.com"}],
  "return_members": true
}
```

### Delete Group

```bash
POST /dropbox-business/2/team/groups/delete
Content-Type: application/json

{".tag": "group_id", "group_id": "g:1d31f47b..."}
```

### Check Group Job Status

```bash
POST /dropbox-business/2/team/groups/job_status/get
Content-Type: application/json

{"async_job_id": "dbjid:..."}
```

## Team Folders

### List Team Folders

```bash
POST /dropbox-business/2/team/team_folder/list
Content-Type: application/json

{"limit": 100}
```

### Get Team Folder Info

```bash
POST /dropbox-business/2/team/team_folder/get_info
Content-Type: application/json

{"team_folder_ids": ["13646676387"]}
```

### Create Team Folder

```bash
POST /dropbox-business/2/team/team_folder/create
Content-Type: application/json

{"name": "Folder Name", "sync_setting": {".tag": "default"}}
```

### Rename Team Folder

```bash
POST /dropbox-business/2/team/team_folder/rename
Content-Type: application/json

{"team_folder_id": "13646676387", "name": "New Name"}
```

### Archive Team Folder

```bash
POST /dropbox-business/2/team/team_folder/archive
Content-Type: application/json

{"team_folder_id": "13646676387", "force_async_off": false}
```

### Activate Team Folder

```bash
POST /dropbox-business/2/team/team_folder/activate
Content-Type: application/json

{"team_folder_id": "13646676387"}
```

### Update Sync Settings

```bash
POST /dropbox-business/2/team/team_folder/update_sync_settings
Content-Type: application/json

{"team_folder_id": "13646676387", "sync_setting": {".tag": "default"}}
```

### Permanently Delete Team Folder

```bash
POST /dropbox-business/2/team/team_folder/permanently_delete
Content-Type: application/json

{"team_folder_id": "13646676387"}
```

## Namespaces

### List Namespaces

```bash
POST /dropbox-business/2/team/namespaces/list
Content-Type: application/json

{"limit": 100}
```

## Devices

### List Members' Devices

```bash
POST /dropbox-business/2/team/devices/list_members_devices
Content-Type: application/json

{}
```

### List Member Devices

```bash
POST /dropbox-business/2/team/devices/list_member_devices
Content-Type: application/json

{"team_member_id": "dbmid:AAA..."}
```

### Revoke Device Session

```bash
POST /dropbox-business/2/team/devices/revoke_device_session
Content-Type: application/json

{".tag": "web_session", "session_id": "dbwsid:...", "team_member_id": "dbmid:AAA..."}
```

### Revoke Device Sessions (Batch)

```bash
POST /dropbox-business/2/team/devices/revoke_device_session_batch
Content-Type: application/json

{
  "revoke_devices": [
    {".tag": "web_session", "session_id": "dbwsid:...", "team_member_id": "dbmid:AAA..."}
  ]
}
```

## Linked Apps

### List Members' Linked Apps

```bash
POST /dropbox-business/2/team/linked_apps/list_members_linked_apps
Content-Type: application/json

{}
```

### List Team Linked Apps

```bash
POST /dropbox-business/2/team/linked_apps/list_team_linked_apps
Content-Type: application/json

{}
```

### Revoke Linked App

```bash
POST /dropbox-business/2/team/linked_apps/revoke_linked_app
Content-Type: application/json

{"app_id": "...", "team_member_id": "dbmid:AAA..."}
```

## Member Space Limits

### Get Custom Quotas

```bash
POST /dropbox-business/2/team/member_space_limits/get_custom_quota
Content-Type: application/json

{"users": [{".tag": "email", "email": "user@company.com"}]}
```

### Set Custom Quotas

```bash
POST /dropbox-business/2/team/member_space_limits/set_custom_quota
Content-Type: application/json

{
  "users_and_quotas": [{
    "user": {".tag": "email", "email": "user@company.com"},
    "quota_gb": 100
  }]
}
```

### List Excluded Users

```bash
POST /dropbox-business/2/team/member_space_limits/excluded_users/list
Content-Type: application/json

{}
```

## Sharing Allowlist

### List Sharing Allowlist

```bash
POST /dropbox-business/2/team/sharing_allowlist/list
Content-Type: application/json

{}
```

### Add to Sharing Allowlist

```bash
POST /dropbox-business/2/team/sharing_allowlist/add
Content-Type: application/json

{"domains": ["partner.com"], "emails": ["external@client.com"]}
```

## Audit Log (Team Log)

### Get Events

```bash
POST /dropbox-business/2/team_log/get_events
Content-Type: application/json

{"limit": 100, "category": {".tag": "members"}}
```

### Continue Getting Events

```bash
POST /dropbox-business/2/team_log/get_events/continue
Content-Type: application/json

{"cursor": "..."}
```

## Member File Access

Use the `Dropbox-API-Select-User` header with a team_member_id to access files on behalf of a member.

### List Member's Files

```bash
POST /dropbox-business/2/files/list_folder
Content-Type: application/json
Dropbox-API-Select-User: dbmid:AAA...

{"path": ""}
```

### List Member's Shared Folders

```bash
POST /dropbox-business/2/sharing/list_folders
Content-Type: application/json
Dropbox-API-Select-User: dbmid:AAA...

{}
```

## Notes

- All endpoints use POST method (even read operations)
- Request bodies must be JSON (use `null` for no-parameter endpoints)
- Many fields use `.tag` format for type indication
- Pagination uses `cursor` and `has_more` fields
- Use V2 endpoints for enhanced responses with roles info
- `Dropbox-API-Select-User` header enables member file access
- System-managed groups cannot be modified
- Reports endpoints (`team/reports/*`) are deprecated

## OAuth Scopes

| Scope              | Usage                 |
| ------------------ | --------------------- |
| `team_info.read`   | Team info, features   |
| `members.read`     | List/get members      |
| `members.write`    | Add/modify members    |
| `members.delete`   | Remove members        |
| `groups.read`      | List/get groups       |
| `groups.write`     | Create/modify groups  |
| `sessions.list`    | List devices/sessions |
| `sessions.modify`  | Revoke sessions       |
| `events.read`      | Team audit log        |
| `team_data.member` | Select-User header    |

## Resources

- [Dropbox Business API Documentation](https://www.dropbox.com/developers/documentation/http/teams)
- [Team Administration Guide](https://developers.dropbox.com/dbx-team-administration-guide)
- [Team Files Guide](https://developers.dropbox.com/dbx-team-files-guide)
