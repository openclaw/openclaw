import os, sys
from google import genai

client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
response = client.models.generate_content(
    model="gemini-2.0-flash",
    contents="SYSTEM: Be concise. USER: " + " ".join(sys.argv[1:]),
)
print(response.text)
