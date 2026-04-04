# Zoho People Routing Reference

**App name:** `zoho-people`
**Base URL proxied:** `people.zoho.com`

## API Path Pattern

```
/zoho-people/people/api/{resource}
```

or for view-based endpoints:

```
/zoho-people/api/forms/{viewName}/records
```

## Common Endpoints

### Forms

```bash
# List all forms
GET /zoho-people/people/api/forms
```

### Records (Bulk)

```bash
# Get records from any form
GET /zoho-people/people/api/forms/{formLinkName}/getRecords?sIndex=1&limit=200

# Common form link names:
# - employee
# - department
# - designation
# - leave
# - P_ClientDetails
```

### Records (View-based)

```bash
# Get records using a view
GET /zoho-people/api/forms/{viewName}/records?rec_limit=200

# Common view names:
# - P_EmployeeView
# - P_DepartmentView
# - P_DesignationView
```

### Search

```bash
# Search by Employee ID
GET /zoho-people/people/api/forms/employee/getRecords?SearchColumn=EMPLOYEEID&SearchValue={empId}

# Search by Email
GET /zoho-people/people/api/forms/employee/getRecords?SearchColumn=EMPLOYEEMAILALIAS&SearchValue={email}

# Get modified records
GET /zoho-people/people/api/forms/{formLinkName}/getRecords?modifiedtime={timestamp_ms}
```

### Insert Record

```bash
POST /zoho-people/people/api/forms/json/{formLinkName}/insertRecord
Content-Type: application/x-www-form-urlencoded

inputData={"field1":"value1","field2":"value2"}
```

### Update Record

```bash
POST /zoho-people/people/api/forms/json/{formLinkName}/updateRecord
Content-Type: application/x-www-form-urlencoded

inputData={"field1":"newValue"}&recordId={recordId}
```

### Attendance

```bash
# Get attendance entries (requires additional scope)
GET /zoho-people/people/api/attendance/getAttendanceEntries?date={date}&dateFormat={format}

# Check-in/Check-out (requires additional scope)
POST /zoho-people/people/api/attendance
Content-Type: application/x-www-form-urlencoded

dateFormat=dd/MM/yyyy HH:mm:ss&checkIn={datetime}&checkOut={datetime}&empId={empId}
```

### Leave

```bash
# Get leave records
GET /zoho-people/people/api/forms/leave/getRecords?sIndex=1&limit=200

# Add leave
POST /zoho-people/people/api/forms/json/leave/insertRecord
Content-Type: application/x-www-form-urlencoded

inputData={"Employee_ID":"EMP001","Leavetype":"123456","From":"01-Feb-2026","To":"02-Feb-2026"}
```

## Common Form Link Names

| Form        | formLinkName      |
| ----------- | ----------------- |
| Employee    | `employee`        |
| Department  | `department`      |
| Designation | `designation`     |
| Leave       | `leave`           |
| Clients     | `P_ClientDetails` |

## Pagination

Uses index-based pagination:

- `sIndex`: Starting index (1-based)
- `limit`: Max records per request (max 200)

For page 2: `sIndex=201&limit=200`

## Notes

- Record IDs are numeric strings (e.g., `943596000000294355`)
- Insert/Update use `application/x-www-form-urlencoded` content type
- `inputData` parameter contains JSON object as string
- Attendance endpoints require additional OAuth scopes
- Maximum 200 records per request
- Response wraps data in `response.result[]` array

## Error Codes

| Code | Description              |
| ---- | ------------------------ |
| 7011 | Invalid form name        |
| 7012 | Invalid view name        |
| 7021 | Max limit exceeded (200) |
| 7024 | No records found         |
| 7042 | Invalid search value     |
| 7218 | Invalid OAuth scope      |

## Resources

- [Zoho People API Overview](https://www.zoho.com/people/api/overview.html)
- [Get Bulk Records API](https://www.zoho.com/people/api/bulk-records.html)
- [Insert Record API](https://www.zoho.com/people/api/insert-records.html)
- [Update Record API](https://www.zoho.com/people/api/update-records.html)
