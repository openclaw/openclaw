#!/bin/bash

# PaddleOCR Document Parser Script

set -e

# Default values
file_type="image"
output_file=""
verbose="false"

# Function to display usage
usage() {
    cat << EOF
Usage: $0 [OPTIONS] INPUT_FILE_PATH_OR_URL

Parse documents using PaddleOCR API

OPTIONS:
    -t, --type TYPE              File type (image, pdf) [default: image]
    -o, --output FILE            Output file [default: stdout]
    -v, --verbose                Verbose output
    -h, --help                   Show this help message

EXAMPLES:
    $0 document.jpg
    $0 -t pdf document.pdf
    $0 -o result.json document.jpg
    $0 https://example.com/document.jpg
EOF
}

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -t|--type)
            file_type="$2"
            shift 2
            ;;
        -o|--output)
            output_file="$2"
            shift 2
            ;;
        -v|--verbose)
            verbose="true"
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        -*)
            echo "Unknown option: $1"
            usage
            exit 1
            ;;
        *)
            input_file="$1"
            shift
            ;;
    esac
done

# Validate input
if [[ -z "$input_file" ]]; then
    echo "Error: Input file path or URL is required"
    usage
    exit 1
fi

# Check if input is a URL or local file
if [[ "$input_file" =~ ^https?:// ]]; then
    is_url="true"
    if [[ "$verbose" == "true" ]]; then
        echo "Input is a URL: $input_file" >&2
    fi
else
    is_url="false"
    if [[ ! -f "$input_file" ]]; then
        echo "Error: Input file not found: $input_file"
        exit 1
    fi
    if [[ "$verbose" == "true" ]]; then
        echo "Input is a local file: $input_file" >&2
    fi
fi

# Validate file type
case "$file_type" in
    image|img) file_type_code=1 ;;
    pdf) file_type_code=0 ;;
    *)
        echo "Error: Invalid file type '$file_type'. Supported: image, pdf"
        exit 1
        ;;
esac

# Check environment variables
if [[ -z "$PADDLEOCR_API_URL" ]]; then
    echo "Error: PADDLEOCR_API_URL environment variable is required"
    echo "Get it from: https://www.paddleocr.com"
    exit 1
fi

if [[ -z "$PADDLEOCR_ACCESS_TOKEN" ]]; then
    echo "Error: PADDLEOCR_ACCESS_TOKEN environment variable is required"
    echo "Get it from: https://www.paddleocr.com"
    exit 1
fi

# Build payload - directly use URL or encode file
if [[ "$is_url" == "true" ]]; then
    # Use URL directly in payload
    payload=$(cat <<EOF
{
    "file": "$input_file",
    "fileType": $file_type_code,
    "useDocOrientationClassify": false,
    "useDocUnwarping": false
}
EOF
)
    if [[ "$verbose" == "true" ]]; then
        echo "Using URL directly in API request" >&2
    fi
else
    # Encode local file to base64
    if [[ "$verbose" == "true" ]]; then
        echo "Encoding $input_file to base64..." >&2
    fi

    file_base64=$(cat "$input_file" | base64 | tr -d '\n')

    payload=$(cat <<EOF
{
    "file": "$file_base64",
    "fileType": $file_type_code,
    "useDocOrientationClassify": false,
    "useDocUnwarping": false
}
EOF
)
fi

if [[ "$verbose" == "true" ]]; then
    echo "Making API request to: $PADDLEOCR_API_URL" >&2
    echo "Payload size: ${#payload} bytes" >&2
fi

# Make API request
# Use temporary file to avoid "Argument list too long" error for large payloads
payload_file=$(mktemp)
echo "$payload" > "$payload_file"

if [[ "$verbose" == "true" ]]; then
    echo "Request payload saved to temporary file: $payload_file" >&2
fi

# Use trap to ensure temporary file cleanup on script exit
cleanup() {
    if [[ -f "$payload_file" ]]; then
        rm -f "$payload_file"
        if [[ "$verbose" == "true" ]]; then
            echo "Cleaned up temporary file: $payload_file" >&2
        fi
    fi
}
trap cleanup EXIT

response=$(curl -s -X POST "$PADDLEOCR_API_URL" \
    -m 600 \
    --fail-with-body \
    -H "Authorization: token $PADDLEOCR_ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    -d @"$payload_file")

# Check for curl errors
curl_exit_code=$?
if [[ $curl_exit_code -ne 0 ]]; then
    echo "Error: Curl request failed with code $curl_exit_code"
    exit 1
fi

# Check response for errors using jq
if ! echo "$response" | jq -e . >/dev/null 2>&1; then
    echo "Error: Invalid JSON response from API"
    exit 1
fi

error_code=$(echo "$response" | jq -r '.errorCode // empty')
error_msg=$(echo "$response" | jq -r '.errorMsg // empty')

if [[ -n "$error_code" && "$error_code" != "0" ]]; then
    echo "API Error ($error_code): $error_msg"
    exit 1
fi

# Extract and process result
if [[ -n "$output_file" ]]; then
    echo "$response" > "$output_file"
    if [[ "$verbose" == "true" ]]; then
        echo "Output saved to: $output_file" >&2
    fi
else
    echo "$response"
fi

if [[ "$verbose" == "true" ]]; then
    echo "Processing completed successfully" >&2
fi
