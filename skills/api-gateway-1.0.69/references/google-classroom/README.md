# Google Classroom Routing Reference

**App name:** `google-classroom`
**Base URL proxied:** `classroom.googleapis.com`

## API Path Pattern

```
/google-classroom/v1/{resource}
```

## Common Endpoints

### Courses

#### List Courses

```bash
GET /google-classroom/v1/courses
GET /google-classroom/v1/courses?courseStates=ACTIVE
GET /google-classroom/v1/courses?teacherId=me
```

#### Get Course

```bash
GET /google-classroom/v1/courses/{courseId}
```

#### Create Course

```bash
POST /google-classroom/v1/courses
Content-Type: application/json

{
  "name": "Course Name",
  "ownerId": "me"
}
```

#### Update Course

```bash
PATCH /google-classroom/v1/courses/{courseId}?updateMask=name
Content-Type: application/json

{
  "name": "Updated Name"
}
```

#### Delete Course

```bash
DELETE /google-classroom/v1/courses/{courseId}
```

### Course Work

#### List Course Work

```bash
GET /google-classroom/v1/courses/{courseId}/courseWork
```

#### Create Course Work

```bash
POST /google-classroom/v1/courses/{courseId}/courseWork
Content-Type: application/json

{
  "title": "Assignment Title",
  "workType": "ASSIGNMENT",
  "state": "PUBLISHED",
  "maxPoints": 100
}
```

### Student Submissions

#### List Submissions

```bash
GET /google-classroom/v1/courses/{courseId}/courseWork/{courseWorkId}/studentSubmissions
```

### Teachers & Students

#### List Teachers

```bash
GET /google-classroom/v1/courses/{courseId}/teachers
```

#### List Students

```bash
GET /google-classroom/v1/courses/{courseId}/students
```

### Announcements

#### List Announcements

```bash
GET /google-classroom/v1/courses/{courseId}/announcements
```

#### Create Announcement

```bash
POST /google-classroom/v1/courses/{courseId}/announcements
Content-Type: application/json

{
  "text": "Announcement text",
  "state": "PUBLISHED"
}
```

### Topics

#### List Topics

```bash
GET /google-classroom/v1/courses/{courseId}/topics
```

### User Profiles

#### Get Current User

```bash
GET /google-classroom/v1/userProfiles/me
```

### Invitations

#### List Invitations

```bash
GET /google-classroom/v1/invitations?courseId={courseId}
```

## Notes

- PATCH requests require `updateMask` query parameter
- Courses must be archived before deletion
- Student submissions require course work to be in PUBLISHED state
- Use `me` for current user ID
- Pagination uses `pageToken` parameter

## Resources

- [Google Classroom API Documentation](https://developers.google.com/workspace/classroom/reference/rest)
- [Courses Reference](https://developers.google.com/workspace/classroom/reference/rest/v1/courses)
- [CourseWork Reference](https://developers.google.com/workspace/classroom/reference/rest/v1/courses.courseWork)
