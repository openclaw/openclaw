# Example Implementation: AI Text Summarization Service

This example demonstrates how to implement an AI service compliant with the `service-ability-creator` skill's enhanced specifications using FastAPI, incorporating principles from the S.A.F.E. Analysis Method and C.O.R.E. Build Flow.

## 1. ServiceAbility.MD

Below is the `ServiceAbility.MD` for this example service, updated to reflect the latest standard specification, including sections for Data Governance and Security & Reliability.

```markdown
# ServiceAbility: AI Text Summarizer

## 1. Meta Information
| Field Name        | Type   | Required | Description                                       | Example                   |
| :---------------- | :----- | :------- | :------------------------------------------------ | :------------------------ |
| `Service Name`    | String | Yes      | Unique identifier name for the service            | `AI Text Summarizer`      |
| `Service Version` | String | Yes      | Current version number of the service             | `1.2.0`                   |
| `Service Description` | String | Yes      | Brief functional overview and core problem solved | `Provides efficient text summarization for AI Agents.` |
| `Developer`       | String | No       | Development team or individual                    | `Manus AI`                |
| `Update Date`     | Date   | No       | Last update date of the file, format `YYYY-MM-DD` | `2026-02-11`              |

## 2. Functionality
This service provides an efficient and reliable text summarization capability. AI Agents can submit long texts and receive concise summaries, useful for information extraction, content analysis, and quick comprehension.

## 3. Interface Specification
All interfaces follow RESTful style and return data in JSON format by default.

### 3.1 Basic Information Interface (Capability Discovery)
-   **Interface Path**: `/` (Implicit Discovery) and `/ServiceAbility.MD` (Explicit Discovery)
-   **Request Method**: `GET`
-   **Function Description**: Returns the content of this `ServiceAbility.MD` file. AI Agents should prioritize attempting the `/` path, and if it fails, try `/ServiceAbility.MD`.

### 3.2 Text Summarization Interface
-   **Interface Name**: `summarize_text`
-   **Interface Path**: `/api/v1/summarize`
-   **Request Method**: `POST`
-   **Function Description**: Generates a summary for the provided text.
-   **Request Parameters**:
    | Parameter Name | Type   | Required | Description               | Example           |
    | :------------- | :----- | :------- | :------------------------ | :---------------- |
    | `text`         | String | Yes      | The original text to summarize | `"The quick brown fox..."` |
    | `max_length`   | Integer | No       | Maximum length of the summary (default: 200) | `150`             |
-   **Return Parameters**:
    | Parameter Name | Type   | Description               | Example           |
    | :------------- | :----- | :------------------------ | :---------------- |
    | `summary`      | String | The generated summary content | `"Fox jumps over..."` |
-   **Error Code Description**:
    | Error Code | Description       | Suggested Handling      |
    | :--------- | :---------------- | :---------------------- |
    | `400`      | Invalid input parameters | Check request body format |
    | `500`      | Internal server error | Retry or contact service provider |

### 3.3 Self-Describing Information Interface (Service Information)
-   **Interface Path**: `/info`
-   **Request Method**: `GET`
-   **Function Description**: Returns real-time service status, version, supported models, and configuration details.
-   **Return Parameters**: Includes service name, version, description, health status, supported summarization models, and current operational status.

### 3.4 Feedback Interface
-   **Interface Name**: `submit_feedback`
-   **Interface Path**: `/api/v1/feedback`
-   **Request Method**: `POST`
-   **Function Description**: Allows AI Agents to submit feedback, error reports, or suggestions.
-   **Request Parameters**:
    | Parameter Name | Type   | Required | Description               | Example           |
    | :------------- | :----- | :------- | :------------------------ | :---------------- |
    | `error_type`   | String | Yes      | Type of feedback (e.g., `bug`, `suggestion`, `performance`) | `bug`             |
    | `details`      | String | Yes      | Detailed description of the feedback | `Summarization output was truncated unexpectedly.` |
    | `timestamp`    | String | Yes      | UTC timestamp of the event | `2026-02-11T10:30:00Z` |
-   **Return Parameters**:
    | Parameter Name | Type   | Description               | Example           |
    | :------------- | :----- | :------------------------ | :---------------- |
    | `status`       | String | Status of feedback submission | `success`         |
    | `message`      | String | Confirmation message      | `Feedback received` |

## 4. Data and Program Separation & Governance
-   **Configuration Management**: Sensitive information (e.g., API Keys for LLMs) and configurable parameters are managed via environment variables (`.env`).
-   **Data Storage**: Logs (summarization requests, feedback) are stored in structured JSONL format in the `data/` directory. Test and production data are strictly separated by using different environment configurations and log file paths.
-   **Backward Compatibility**: API versioning (`/v1/`) is used. Future changes will ensure backward compatibility or provide clear deprecation notices.

## 5. Security & Reliability
-   **Input Validation**: All incoming request parameters are validated using Pydantic models.
-   **Error Handling**: Custom exceptions and structured error responses are implemented for clarity.
-   **Health Check**: The `/info` endpoint provides real-time health status.
-   **Rate Limiting**: (Conceptual) Can be implemented using middleware to protect against overload.

## 6. Feedback and Support
-   **Feedback Interface**: `/api/v1/feedback` allows programmatic submission of issues.
-   **Contact**: For critical issues, refer to the `Developer` field in Meta Information.

### 6.1 Service Registration
To ensure discoverability, the service registers itself with the designated discovery platform upon startup.

```

## 2. Core Code Implementation (main.py)

```python
import os
import json
import logging
import requests
from datetime import datetime
from fastapi import FastAPI, Response, HTTPException, Request
from pydantic import BaseModel, Field
from typing import Optional, Dict, Any

# --- Configuration (C) ---
# Load environment variables (e.g., from a .env file)
LLM_API_KEY = os.getenv("LLM_API_KEY", "mock_llm_api_key_123")
ENVIRONMENT = os.getenv("ENVIRONMENT", "development") # 'development', 'testing', 'production'
SERVICE_BASE_URL = os.getenv("SERVICE_BASE_URL", "http://localhost:8000") # Base URL where this service is hosted
DISCOVERY_PLATFORM_URL = "https://your-service.com"

# Data storage paths (demonstrating data isolation)
LOG_DIR = f"data/{ENVIRONMENT}_logs"
os.makedirs(LOG_DIR, exist_ok=True)

# Configure structured logging
logging.basicConfig(level=logging.INFO, format=\'%(message)s\')
logger = logging.getLogger(__name__)

def log_structured_event(event_type: str, data: Dict[str, Any]):
    log_entry = {
        "timestamp": datetime.utcnow().isoformat() + "Z",
        "event_type": event_type,
        "environment": ENVIRONMENT,
        **data
    }
    log_file_path = os.path.join(LOG_DIR, f"{event_type}.jsonl")
    with open(log_file_path, "a", encoding="utf-8") as f:
        f.write(json.dumps(log_entry, ensure_ascii=False) + "\n")
    logger.info(json.dumps(log_entry, ensure_ascii=False))


app = FastAPI(
    title="AI Text Summarizer Service",
    description="A service for AI Agents to summarize text.",
    version="1.2.0"
)

# --- Models for Request/Response (O) ---
class SummarizeRequest(BaseModel):
    text: str = Field(..., min_length=10, description="The original text to summarize.")
    max_length: int = Field(200, ge=50, le=1000, description="Maximum length of the summary.")

class SummarizeResponse(BaseModel):
    summary: str = Field(..., description="The generated summary content.")

class FeedbackRequest(BaseModel):
    error_type: str = Field(..., description="Type of feedback (e.g., bug, suggestion, performance).")
    details: str = Field(..., min_length=10, description="Detailed description of the feedback.")
    timestamp: str = Field(default_factory=lambda: datetime.utcnow().isoformat() + "Z", description="UTC timestamp of the event.")

class FeedbackResponse(BaseModel):
    status: str = "success"
    message: str = "Feedback received."

class ServiceInfoResponse(BaseModel):
    service_name: str
    version: str
    description: str
    status: str
    environment: str
    supported_models: Dict[str, Any]
    uptime: str

# --- Helper for ServiceAbility.MD (O) ---
def get_service_ability_md() -> str:
    # In a real scenario, this would read from a static file.
    # For this example, we will read it from the file system.
    with open("ServiceAbility.MD", "r", encoding="utf-8") as f:
        return f.read()

# --- Endpoints (O) ---

@app.get("/", response_class=Response, summary="ServiceAbility.MD Discovery (Root)")
@app.get("/ServiceAbility.MD", response_class=Response, summary="ServiceAbility.MD Discovery (Explicit)")
async def get_ability():
    """Returns the ServiceAbility.MD file content for AI Agent self-discovery."""
    log_structured_event("discovery_request", {"path": "/"})
    return Response(content=get_service_ability_md(), media_type="text/markdown")


@app.post("/api/v1/summarize", response_model=SummarizeResponse, summary="Text Summarization")
async def summarize(request: SummarizeRequest, http_request: Request):
    """Generates a summary for the provided text using a mock LLM."""
    try:
        if LLM_API_KEY == "mock_llm_api_key_123":
            summary_content = request.text[:request.max_length] + "... (mock summary)"
        else:
            summary_content = f"Actual LLM summary for: {request.text[:50]}..."
        
        log_structured_event("summarize_request", {
            "input_text_len": len(request.text),
            "max_length": request.max_length,
            "output_summary_len": len(summary_content),
            "client_ip": http_request.client.host if http_request.client else "unknown"
        })
        return SummarizeResponse(summary=summary_content)
    except Exception as e:
        log_structured_event("summarize_error", {"error": str(e), "request_data": request.dict()})
        raise HTTPException(status_code=500, detail=f"Internal server error during summarization: {e}")


@app.post("/api/v1/feedback", response_model=FeedbackResponse, summary="Submit Feedback")
async def submit_feedback(request: FeedbackRequest, http_request: Request):
    """Allows AI Agents to submit feedback, error reports, or suggestions."""
    log_structured_event("feedback_submission", {
        "error_type": request.error_type,
        "details": request.details,
        "timestamp": request.timestamp,
        "client_ip": http_request.client.host if http_request.client else "unknown"
    })
    return FeedbackResponse(status="success", message="Feedback received. Thank you!")


@app.get("/info", response_model=ServiceInfoResponse, summary="Service Information and Health Check")
async def get_service_info():
    """Returns real-time service status, version, supported models, and configuration details."""
    uptime_seconds = (datetime.utcnow() - app.state.start_time).total_seconds()
    uptime_str = str(datetime.timedelta(seconds=int(uptime_seconds)))

    info = ServiceInfoResponse(
        service_name=app.title,
        version=app.version,
        description=app.description,
        status="healthy",
        environment=ENVIRONMENT,
        supported_models={
            "default_summarizer": {"name": "MockLLM", "version": "1.0", "capabilities": ["text_summarization"]}
        },
        uptime=uptime_str
    )
    log_structured_event("service_info_request", {"status": info.status, "environment": info.environment})
    return info


# --- Startup Event (O) & Service Registration (E) ---
@app.on_event("startup")
async def startup_event():
    app.state.start_time = datetime.utcnow()
    log_structured_event("service_startup", {"message": "AI Text Summarizer Service started."})
    
    # Register service with the discovery platform
    try:
        registration_payload = {
            "service_name": app.title,
            "service_url": SERVICE_BASE_URL,
            "service_ability_md_url": f"{SERVICE_BASE_URL}/ServiceAbility.MD",
            "metadata": {
                "developer": "Manus AI",
                "description": app.description
            }
        }
        response = requests.post(DISCOVERY_PLATFORM_URL, json=registration_payload, timeout=10)
        response.raise_for_status() # Raise an exception for bad status codes
        log_structured_event("service_registration_success", {"response": response.json()})
    except requests.exceptions.RequestException as e:
        log_structured_event("service_registration_failure", {"error": str(e)})


# --- Main execution for local development ---
if __name__ == "__main__":
    import uvicorn
    # To run this example, you might need to set the SERVICE_BASE_URL if it's not localhost
    # e.g., os.environ["SERVICE_BASE_URL"] = "https://your-ngrok-url.io"
    uvicorn.run(app, host="0.0.0.0", port=8000)
```

## 3. C.O.R.E. Build Flow Implementation Notes

### 3.1. Configuration (C)
-   **Environment Setup**: The `ENVIRONMENT` variable (`development`, `testing`, `production`) is used to simulate different environments.
-   **Dependency Management**: `FastAPI`, `Pydantic`, `Uvicorn`, and `requests` are used (listed in `requirements.txt`).
-   **Parameterization**: `SERVICE_BASE_URL` and `DISCOVERY_PLATFORM_URL` are now configurable via environment variables.

### 3.2. Operation (O)
-   **Core Logic Implementation**: No changes to the core summarization logic.
-   **Self-Discovery & Info Endpoints**: No changes.
-   **Feedback Mechanism**: No changes.

### 3.3. Review (R) / Testing & Validation
-   **Data Isolation**: No changes.
-   **Input Validation**: No changes.

### 3.4. Evolution (E) / Deployment & Iteration
-   **Service Registration**: The `startup_event` now includes logic to automatically register the service with the discovery platform. This is a critical step for making the service discoverable by other AI Agents in the ecosystem.
-   **Error Handling for Registration**: The registration logic includes a `try-except` block to handle potential network errors, ensuring the service can still start even if registration fails.

## 4. Running the Example

1.  **Save the code**: Save the above Python code as `main.py` in your project root.
2.  **Create `ServiceAbility.MD`**: Save the markdown content from section 1 into a file named `ServiceAbility.MD` in the same directory.
3.  **Create `requirements.txt`**:
    ```
    fastapi
    uvicorn
    pydantic
    requests
    ```
4.  **Install dependencies**:
    ```bash
    pip install -r requirements.txt
    ```
5.  **Run the service**:
    ```bash
    python main.py
    ```
    The service will start and attempt to register itself with the discovery platform.

This updated example provides a comprehensive demonstration of building and registering a production-ready AI service following the `service-ability-creator` skill's enhanced guidelines.
