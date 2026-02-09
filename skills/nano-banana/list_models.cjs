const https = require("https");

const API_KEY = process.env.GEMINI_API_KEY;
const options = {
  hostname: "generativelanguage.googleapis.com",
  path: `/v1beta/models?key=${API_KEY}`,
  method: "GET",
};

const req = https.request(options, (res) => {
  let data = "";
  res.on("data", (chunk) => (data += chunk));
  res.on("end", () => {
    const response = JSON.parse(data);
    if (response.models) {
      console.log("Available Models:");
      response.models.forEach((m) => console.log(`- ${m.name} (${m.supportedGenerationMethods})`));
    } else {
      console.log("Response:", JSON.stringify(response, null, 2));
    }
  });
});

req.end();
