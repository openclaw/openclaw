# List Requests

GET https://api.coperniq.io/v1/requests

Retrieve a paginated list of requests.

Supports:

- Pagination (`page_size`, `page`)
- Date filtering (`updated_after`, `updated_before`)
- Sorting (`order_by`, default: desc)
- Field search (`title`, `address`, `primaryName`, `primaryPhone`, `primaryEmail`)
- Full text search (`q`)

Reference: https://docs.coperniq.io/api-reference/requests/list-requests

## OpenAPI Specification

```yaml
openapi: 3.1.1
info:
  title: List Requests
  version: endpoint_requests.listRequests
paths:
  /requests:
    get:
      operationId: list-requests
      summary: List Requests
      description: >
        Retrieve a paginated list of requests.


        Supports:

        - Pagination (`page_size`, `page`)

        - Date filtering (`updated_after`, `updated_before`)

        - Sorting (`order_by`, default: desc)

        - Field search (`title`, `address`, `primaryName`, `primaryPhone`,
        `primaryEmail`)

        - Full text search (`q`)
      tags:
        - - subpackage_requests
      parameters:
        - name: page_size
          in: query
          description: Number of items per page (max 100)
          required: false
          schema:
            type: integer
            default: 20
        - name: page
          in: query
          description: Page number (1-based)
          required: false
          schema:
            type: integer
            default: 1
        - name: updated_after
          in: query
          description: Filter items updated after this timestamp (ISO 8601)
          required: false
          schema:
            type: string
            format: date-time
        - name: updated_before
          in: query
          description: Filter items updated before this timestamp (ISO 8601)
          required: false
          schema:
            type: string
            format: date-time
        - name: order_by
          in: query
          description: Sort order for results
          required: false
          schema:
            $ref: "#/components/schemas/RequestsGetParametersOrderBy"
        - name: include_virtual_properties
          in: query
          description: >-
            Whether to include virtual properties in the response. Defaults to
            false unless explicitly set to true.
          required: false
          schema:
            type: boolean
            default: false
        - name: q
          in: query
          description: Full text search query
          required: false
          schema:
            type: string
        - name: title
          in: query
          description: Title search query
          required: false
          schema:
            type: string
        - name: address
          in: query
          description: Address search query
          required: false
          schema:
            type: string
        - name: primaryName
          in: query
          description: Contact name search query
          required: false
          schema:
            type: string
        - name: primaryPhone
          in: query
          description: Contact phone search query
          required: false
          schema:
            type: string
        - name: primaryEmail
          in: query
          description: Contact email search query
          required: false
          schema:
            type: string
        - name: x-api-key
          in: header
          required: true
          schema:
            type: string
      responses:
        "200":
          description: List of requests
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: "#/components/schemas/Request"
        "401":
          description: Authentication failed
          content: {}
components:
  schemas:
    RequestsGetParametersOrderBy:
      type: string
      enum:
        - value: asc
        - value: desc
      default: asc
    RequestPhase:
      type: object
      properties:
        id:
          type: integer
        name:
          type: string
        type:
          type: string
    PhaseInstanceStatus:
      type: string
      enum:
        - value: NOT_STARTED
        - value: IN_PROGRESS
        - value: COMPLETED
    PhaseTemplateSummary:
      type: object
      properties:
        id:
          type: integer
        name:
          type: string
        type:
          type: string
        redSla:
          type:
            - integer
            - "null"
        yellowSla:
          type:
            - integer
            - "null"
    PhaseInstance:
      type: object
      properties:
        id:
          type: integer
        name:
          type: string
        status:
          $ref: "#/components/schemas/PhaseInstanceStatus"
        position:
          type: integer
        type:
          type: string
        phaseTemplateId:
          type: integer
        phaseTemplate:
          $ref: "#/components/schemas/PhaseTemplateSummary"
    RequestOwner:
      type: object
      properties:
        id:
          type: integer
        firstName:
          type: string
        lastName:
          type: string
        email:
          type: string
        phone:
          type:
            - string
            - "null"
        avatarUrl:
          type:
            - string
            - "null"
    RequestSalesRep:
      type: object
      properties:
        id:
          type: integer
        firstName:
          type: string
        lastName:
          type: string
        email:
          type: string
        phone:
          type:
            - string
            - "null"
        avatarUrl:
          type:
            - string
            - "null"
    RequestProjectManager:
      type: object
      properties:
        id:
          type: integer
        firstName:
          type: string
        lastName:
          type: string
        email:
          type: string
        phone:
          type:
            - string
            - "null"
        avatarUrl:
          type:
            - string
            - "null"
    RequestJurisdiction:
      type: object
      properties:
        id:
          type: integer
        name:
          type: string
        uuid:
          type: string
    Request:
      type: object
      properties:
        id:
          type: integer
          description: Unique identifier
        createdAt:
          type: string
          format: date-time
          description: Creation timestamp
        updatedAt:
          type: string
          format: date-time
          description: Last update timestamp
        title:
          type: string
          description: Record title/name
        description:
          type:
            - string
            - "null"
          description: Record description
        address:
          type: array
          items:
            type: string
          description: >-
            An array containing a single string, which represents the full
            request location/address.
        isActive:
          type: boolean
          description: Whether the record is active
        primaryEmail:
          type:
            - string
            - "null"
          format: email
          description: Primary contact email
        primaryPhone:
          type:
            - string
            - "null"
          description: Primary contact phone
        number:
          type: integer
          description: Sequential request number
        custom:
          type: object
          additionalProperties:
            description: Any type
          description: Custom fields
        trades:
          type: array
          items:
            type: string
          description: Array of trade types
        value:
          type:
            - number
            - "null"
          format: double
          description: Deal value
        size:
          type:
            - number
            - "null"
          format: double
          description: Deal size
        confidence:
          type:
            - number
            - "null"
          format: double
          description: Deal confidence score (0-100)
        workflowId:
          type:
            - integer
            - "null"
          description: Associated workflow ID
        clientId:
          type:
            - integer
            - "null"
          description: Associated client ID
        createdById:
          type: integer
          description: Identifier of the user who created the request
        geoLocation:
          type: array
          items:
            type: string
          description: Latitude/Longitude in "lat,lon" format
        imageUrl:
          type:
            - string
            - "null"
          description: Image URL for the request
        streetViewUrl:
          type:
            - string
            - "null"
          description: Street view image URL
        city:
          type: string
        zipcode:
          type: string
        state:
          type: string
        street:
          type: string
        phase:
          oneOf:
            - $ref: "#/components/schemas/RequestPhase"
            - type: "null"
        phaseInstances:
          type: array
          items:
            $ref: "#/components/schemas/PhaseInstance"
          description: Ordered list of phase instances for the request
        owner:
          oneOf:
            - $ref: "#/components/schemas/RequestOwner"
            - type: "null"
        salesRep:
          oneOf:
            - $ref: "#/components/schemas/RequestSalesRep"
            - type: "null"
        projectManager:
          oneOf:
            - $ref: "#/components/schemas/RequestProjectManager"
            - type: "null"
        jurisdiction:
          oneOf:
            - $ref: "#/components/schemas/RequestJurisdiction"
            - type: "null"
        lastActivity:
          type:
            - string
            - "null"
          format: date-time
        phaseId:
          type:
            - integer
            - "null"
        workflowName:
          type: string
          description: |
            Name of the associated workflow.
```

## SDK Code Examples

```python
import requests

url = "https://api.coperniq.io/v1/requests"

payload = {}
headers = {
    "x-api-key": "<apiKey>",
    "Content-Type": "application/json"
}

response = requests.get(url, json=payload, headers=headers)

print(response.json())
```

```javascript
const url = "https://api.coperniq.io/v1/requests";
const options = {
  method: "GET",
  headers: { "x-api-key": "<apiKey>", "Content-Type": "application/json" },
  body: "{}",
};

try {
  const response = await fetch(url, options);
  const data = await response.json();
  console.log(data);
} catch (error) {
  console.error(error);
}
```

```go
package main

import (
	"fmt"
	"strings"
	"net/http"
	"io"
)

func main() {

	url := "https://api.coperniq.io/v1/requests"

	payload := strings.NewReader("{}")

	req, _ := http.NewRequest("GET", url, payload)

	req.Header.Add("x-api-key", "<apiKey>")
	req.Header.Add("Content-Type", "application/json")

	res, _ := http.DefaultClient.Do(req)

	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)

	fmt.Println(res)
	fmt.Println(string(body))

}
```

```ruby
require 'uri'
require 'net/http'

url = URI("https://api.coperniq.io/v1/requests")

http = Net::HTTP.new(url.host, url.port)
http.use_ssl = true

request = Net::HTTP::Get.new(url)
request["x-api-key"] = '<apiKey>'
request["Content-Type"] = 'application/json'
request.body = "{}"

response = http.request(request)
puts response.read_body
```

```java
import com.mashape.unirest.http.HttpResponse;
import com.mashape.unirest.http.Unirest;

HttpResponse<String> response = Unirest.get("https://api.coperniq.io/v1/requests")
  .header("x-api-key", "<apiKey>")
  .header("Content-Type", "application/json")
  .body("{}")
  .asString();
```

```php
<?php
require_once('vendor/autoload.php');

$client = new \GuzzleHttp\Client();

$response = $client->request('GET', 'https://api.coperniq.io/v1/requests', [
  'body' => '{}',
  'headers' => [
    'Content-Type' => 'application/json',
    'x-api-key' => '<apiKey>',
  ],
]);

echo $response->getBody();
```

```csharp
using RestSharp;

var client = new RestClient("https://api.coperniq.io/v1/requests");
var request = new RestRequest(Method.GET);
request.AddHeader("x-api-key", "<apiKey>");
request.AddHeader("Content-Type", "application/json");
request.AddParameter("application/json", "{}", ParameterType.RequestBody);
IRestResponse response = client.Execute(request);
```

```swift
import Foundation

let headers = [
  "x-api-key": "<apiKey>",
  "Content-Type": "application/json"
]
let parameters = [] as [String : Any]

let postData = JSONSerialization.data(withJSONObject: parameters, options: [])

let request = NSMutableURLRequest(url: NSURL(string: "https://api.coperniq.io/v1/requests")! as URL,
                                        cachePolicy: .useProtocolCachePolicy,
                                    timeoutInterval: 10.0)
request.httpMethod = "GET"
request.allHTTPHeaderFields = headers
request.httpBody = postData as Data

let session = URLSession.shared
let dataTask = session.dataTask(with: request as URLRequest, completionHandler: { (data, response, error) -> Void in
  if (error != nil) {
    print(error as Any)
  } else {
    let httpResponse = response as? HTTPURLResponse
    print(httpResponse)
  }
})

dataTask.resume()
```

curl https://api.coperniq.io/v1/requests \
 -H "x-api-key: <apiKey>" \
 -H "Content-Type: application/json"

[
{
"address": [
"123 Main St, Springfield, IL 62704"
],
"city": "Springfield",
"clientId": 45,
"confidence": 85.5,
"createdAt": "2024-01-15T09:30:00Z",
"createdById": 7,
"custom": {
"priority": "High",
"requestedBy": "Facilities Department"
},
"description": "Renovation project for the main office building in downtown.",
"geoLocation": [
"39.7817,-89.6501"
],
"id": 1,
"imageUrl": "https://cdn.coperniq.io/images/projects/1024/main_building.jpg",
"isActive": true,
"jurisdiction": {
"id": 5,
"name": "Springfield Building Authority",
"uuid": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
},
"lastActivity": "2024-01-14T16:45:00Z",
"number": 1024,
"owner": {
"id": 22,
"firstName": "Alice",
"lastName": "Johnson",
"email": "alice.johnson@downtownoffice.com",
"phone": "+1-217-555-0123",
"avatarUrl": "https://cdn.coperniq.io/avatars/alice_johnson.png"
},
"phase": {
"id": 3,
"name": "Design Phase",
"type": "Planning"
},
"phaseId": 3,
"phaseInstances": [
{
"id": 101,
"name": "Initial Design",
"status": "IN_PROGRESS",
"position": 1,
"type": "Design",
"phaseTemplateId": 5,
"phaseTemplate": {
"id": 5,
"name": "Design Template",
"type": "Design",
"redSla": 10,
"yellowSla": 5
}
}
],
"primaryEmail": "contact@downtownoffice.com",
"primaryPhone": "+1-217-555-0198",
"projectManager": {
"id": 44,
"firstName": "Carol",
"lastName": "Davis",
"email": "carol.davis@coperniqpm.com",
"phone": "+1-217-555-0789",
"avatarUrl": "https://cdn.coperniq.io/avatars/carol_davis.png"
},
"salesRep": {
"id": 33,
"firstName": "Bob",
"lastName": "Smith",
"email": "bob.smith@coperniqsales.com",
"phone": "+1-217-555-0456",
"avatarUrl": "https://cdn.coperniq.io/avatars/bob_smith.png"
},
"size": 15000.5,
"state": "IL",
"street": "123 Main St",
"streetViewUrl": "https://maps.googleapis.com/maps/api/streetview?location=39.7817,-89.6501&size=600x300",
"title": "Downtown Office Renovation",
"trades": [
"Electrical",
"Plumbing",
"Carpentry"
],
"updatedAt": "2024-01-15T09:30:00Z",
"value": 250000,
"workflowId": 12,
"workflowName": "Standard Renovation Workflow",
"zipcode": "62704"
}
]
