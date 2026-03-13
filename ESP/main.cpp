/**
 * OpenClaw ESP32-S3 Node Firmware v3.0.0
 * Ed25519 signature + Base64 URL encoding
 * Correct v3 auth payload format
 *
 * @date 2026-03-04
 */

#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <mbedtls/md.h>
#include <mbedtls/base64.h>
#include <time.h>

// Ed25519 library
#define ED25519_DLL
#include <ed25519.h>

// ==================== Config ====================

const char* WIFI_SSID = "WK2.4G-1H1D1901";
const char* WIFI_PASSWORD = "chen580231";

const char* GATEWAY_HOST = "192.168.2.116";
const int GATEWAY_PORT = 18789;

const char* NODE_CLIENT_ID = "node-host";
const char* NODE_NAME = "ESP32-S3 Node";
const char* NODE_VERSION = "3.0.0";
const char* NODE_PLATFORM = "esp32";
const char* NODE_DEVICE_FAMILY = "esp32-s3";
const char* NODE_MODE = "node";
const char* NODE_ROLE = "node";
const char* NODE_SCOPE = "node.admin";

#define PROTOCOL_VERSION 3
#define NODE_LED_PIN 2
#define BUTTON_PIN 0

// Gateway auth token (from OpenClaw config: gateway.auth.token)
const char* GATEWAY_AUTH_TOKEN = "f81890ae55aba1faa181e210005330eb08ca223673c2f596";

const char* NODE_CAPS[] = {"sensor.read", "camera.snap", "system.notify", "device.info", "relay.set", "ota.update", "imu.read", "audio.capture", "audio.play"};
const char* NODE_COMMANDS[] = {"sensor.read", "camera.snap", "system.notify", "device.info", "relay.set", "ota.update", "imu.read", "audio.capture", "audio.play"};
#define CAPS_COUNT 9
#define COMMANDS_COUNT 9

// ==================== Globals ====================

Preferences preferences;
WiFiClient wifiClient;

enum ConnectState {
    STATE_DISCONNECTED,
    STATE_HANDSHAKE_DONE,
    STATE_WAITING_CHALLENGE,
    STATE_AUTH_SENT,
    STATE_PAIRED
};

ConnectState connectState = STATE_DISCONNECTED;
bool wsConnected = false;
bool paired = false;
bool waitingForApproval = false;

unsigned long lastPing = 0;
unsigned long lastReconnect = 0;
unsigned long lastStatusReport = 0;

String wsNonce = "";
String nodeToken = "";
String publicKeyPem = "";
String deviceId = "";

// Ed25519 keys (32 bytes public, 64 bytes private)
unsigned char ed25519PublicKey[32];
unsigned char ed25519PrivateKey[64];
bool keysInitialized = false;

// ==================== Forward declarations ====================

String base64Encode(const uint8_t* data, size_t len);
void initKeys();
void loadOrGenerateDeviceId();
void loadPairedToken();
void savePairedToken(const char* token);
void clearPairedToken();
void connectWiFi();
bool connectWebSocket();
void handleWebSocket();
void disconnectWebSocket();
void parseMessage(String msg);
void handleConnectChallenge(String nonce);
void sendConnectRequest();
void handleConnectResolved(bool success, String payload);
void handlePairResolved(String decision, String token);
void handleInvokeRequest(String id, String command, String paramsJSON);
void sendWSFrame(String data, bool isText = true);
void sendRequest(const char* method, String params);
void sendResponse(String id, bool ok, String payload);
void sendEvent(const char* eventName, String payload);
void cmdSensorRead(String reqId);
void cmdCameraSnap(String reqId);
void cmdDeviceInfo(String reqId);
void cmdSystemNotify(String reqId, String message);
void blinkLED(int times, int delayMs);
String generateUUID();
String base64UrlEncode(const uint8_t* data, size_t len);
String signData(String data);
String buildAuthPayload(String nonce);
String getPublicKeyPem();

// ==================== Setup ====================

void setup() {
    delay(2000);
    Serial.begin(74880);
    delay(200);

    Serial.println("\n========================================");
    Serial.println("  OpenClaw ESP32-S3 Node v3.0.0");
    Serial.println("========================================");
    Serial.flush();

    pinMode(NODE_LED_PIN, OUTPUT);
    pinMode(BUTTON_PIN, INPUT_PULLUP);
    blinkLED(3, 100);

    preferences.begin("openclaw", false);
    Serial.println("[INIT] Preferences opened");

    // Initialize keys first (sets deviceId from public key)
    initKeys();

    loadPairedToken();
    if (nodeToken.length() > 0) {
        Serial.println("[INIT] Found paired token");
        paired = true;
    }

    connectWiFi();

    Serial.println("\n[INIT] Node Ready");
    Serial.println("[INIT] Node ID: " + deviceId);
    Serial.println("[INIT] Paired: " + String(paired ? "Yes" : "No"));
    Serial.flush();
}

// ==================== Loop ====================

void loop() {
    handleWebSocket();

    if (!wsConnected && millis() - lastReconnect > 5000) {
        lastReconnect = millis();
        Serial.println("[LOOP] Reconnecting...");
        connectWebSocket();
    }

    if (wsConnected && paired && millis() - lastStatusReport > 60000) {
        lastStatusReport = millis();
        cmdDeviceInfo("");
    }

    static unsigned long lastBlink = 0;
    if (millis() - lastBlink > 2000) {
        lastBlink = millis();
        if (wsConnected && paired) {
            digitalWrite(NODE_LED_PIN, HIGH);
            delay(50);
            digitalWrite(NODE_LED_PIN, LOW);
        } else if (wsConnected && waitingForApproval) {
            blinkLED(2, 100);
        } else {
            digitalWrite(NODE_LED_PIN, HIGH);
            delay(200);
            digitalWrite(NODE_LED_PIN, LOW);
        }
    }

    delay(10);
}

// ==================== Device ID ====================

String deriveDeviceIdFromPublicKey() {
    // For Ed25519, hash the raw 32-byte public key
    unsigned char hash[32];
    mbedtls_md_context_t mdCtx;
    mbedtls_md_init(&mdCtx);
    mbedtls_md_setup(&mdCtx, mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), 0);
    mbedtls_md_starts(&mdCtx);
    mbedtls_md_update(&mdCtx, ed25519PublicKey, 32);  // Raw 32-byte key
    mbedtls_md_finish(&mdCtx, hash);
    mbedtls_md_free(&mdCtx);

    // Convert to hex string
    String id = "";
    for (int i = 0; i < 32; i++) {
        char hex[3];
        snprintf(hex, sizeof(hex), "%02x", hash[i]);
        id += hex;
    }

    return id;
}

void loadOrGenerateDeviceId() {
    // Device ID will be derived from public key after key generation
    // This is called after initKeys()
}

// ==================== Token persistence ====================

void loadPairedToken() {
    nodeToken = preferences.getString("pair_token", "");
}

void savePairedToken(const char* token) {
    nodeToken = String(token);
    preferences.putString("pair_token", token);
    Serial.println("[PAIR] Token saved to NVS");
}

void clearPairedToken() {
    nodeToken = "";
    preferences.remove("pair_token");
    paired = false;
    Serial.println("[PAIR] Token cleared");
}

// ==================== Keys ====================

void initKeys() {
    Serial.println("[CRYPTO] Initializing Ed25519 keys...");

    // Load persisted keys if available
    String savedPubKey = preferences.getString("pubkey", "");
    String savedPrivKey = preferences.getString("privkey", "");

    if (savedPubKey.length() == 64 && savedPrivKey.length() == 128) {
        // Load existing keys from NVS
        Serial.println("[CRYPTO] Loading persisted keys...");
        for (int i = 0; i < 32; i++) {
            String byteStr = savedPubKey.substring(i * 2, i * 2 + 2);
            ed25519PublicKey[i] = (unsigned char)strtol(byteStr.c_str(), NULL, 16);
        }
        for (int i = 0; i < 64; i++) {
            String byteStr = savedPrivKey.substring(i * 2, i * 2 + 2);
            ed25519PrivateKey[i] = (unsigned char)strtol(byteStr.c_str(), NULL, 16);
        }
    } else {
        // Generate new keys and persist
        Serial.println("[CRYPTO] Generating new Ed25519 keypair...");

        // Generate random seed using ESP32 hardware RNG
        unsigned char seed[32];
        for (int i = 0; i < 32; i++) {
            seed[i] = (unsigned char)(esp_random() & 0xFF);
        }

        // Create Ed25519 keypair
        ed25519_create_keypair(ed25519PublicKey, ed25519PrivateKey, seed);

        // Save keys to Preferences (hex format)
        String pubKeyHex = "";
        String privKeyHex = "";
        for (int i = 0; i < 32; i++) {
            char buf[3];
            sprintf(buf, "%02x", ed25519PublicKey[i]);
            pubKeyHex += buf;
        }
        for (int i = 0; i < 64; i++) {
            char buf[3];
            sprintf(buf, "%02x", ed25519PrivateKey[i]);
            privKeyHex += buf;
        }
        preferences.putString("pubkey", pubKeyHex);
        preferences.putString("privkey", privKeyHex);
        Serial.println("[CRYPTO] Keys persisted to NVS");
    }

    // Create PEM format public key for compatibility
    // OpenClaw expects: -----BEGIN PUBLIC KEY----- with SPKI DER format
    // Ed25519 SPKI prefix: 302a300506032b6570032100 (12 bytes) + 32 bytes raw key
    unsigned char spkiKey[44] = {
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00
    };
    memcpy(spkiKey + 12, ed25519PublicKey, 32);

    // Base64 encode the SPKI key
    publicKeyPem = "-----BEGIN PUBLIC KEY-----\n";
    publicKeyPem += base64Encode(spkiKey, 44);
    publicKeyPem += "\n-----END PUBLIC KEY-----\n";

    Serial.println("[CRYPTO] Public key generated:");
    Serial.println(publicKeyPem);

    // Device ID is SHA-256 of raw public key (32 bytes)
    deviceId = deriveDeviceIdFromPublicKey();
    if (deviceId.length() == 0) {
        Serial.println("[CRYPTO] Failed to derive device ID");
        keysInitialized = false;
        return;
    }
    Serial.println("[CRYPTO] Device ID: " + deviceId);

    keysInitialized = true;
    Serial.println("[CRYPTO] Keys initialized OK (Ed25519)");
}

String getPublicKeyPem() {
    // Return the pre-generated PEM (from initKeys)
    return publicKeyPem;
}

// ==================== Standard Base64 (for WebSocket handshake) ====================

String base64Encode(const uint8_t* data, size_t len) {
    size_t outLen;
    mbedtls_base64_encode(NULL, 0, &outLen, data, len);

    unsigned char* outBuf = (unsigned char*)malloc(outLen);
    if (!outBuf) {
        return "";
    }

    int ret = mbedtls_base64_encode(outBuf, outLen, &outLen, data, len);
    if (ret != 0) {
        free(outBuf);
        return "";
    }

    String result = String((char*)outBuf);
    free(outBuf);

    // Remove newlines only
    result.replace("\n", "");
    result.replace("\r", "");

    return result;
}

// ==================== Base64 URL (for signatures) ====================

String base64UrlEncode(const uint8_t* data, size_t len) {
    String result = base64Encode(data, len);
    if (result.length() == 0) {
        return "";
    }

    // Convert to URL-safe base64
    result.replace("+", "-");
    result.replace("/", "_");

    // Remove padding
    int eqPos = result.indexOf('=');
    if (eqPos > 0) {
        result = result.substring(0, eqPos);
    }

    return result;
}

// ==================== Auth payload ====================

String buildAuthPayload(String nonce) {
    // Use device token when paired, otherwise use gateway auth token for initial pairing
    String token = paired ? nodeToken : String(GATEWAY_AUTH_TOKEN);

    // Use NTP time for signature (milliseconds since epoch)
    unsigned long long signedAtMs = 0;
    struct tm timeInfo;
    if (getLocalTime(&timeInfo)) {
        time_t now = mktime(&timeInfo);
        signedAtMs = (unsigned long long)now * 1000ULL;
    } else {
        // Fallback to millis() if NTP not available
        signedAtMs = millis();
    }

    String payload = "v3|";
    payload += deviceId + "|";
    payload += String(NODE_CLIENT_ID) + "|";
    payload += String(NODE_MODE) + "|";
    payload += String(NODE_ROLE) + "|";
    payload += String(NODE_SCOPE) + "|";
    payload += String(signedAtMs) + "|";
    payload += token + "|";
    payload += nonce + "|";
    payload += String(NODE_PLATFORM) + "|";
    payload += String(NODE_DEVICE_FAMILY);

    return payload;
}

// ==================== Signing ====================

String signData(String data) {
    if (!keysInitialized) {
        Serial.println("[CRYPTO] Keys not initialized!");
        return "";
    }

    // Ed25519 signs the raw message directly (no hash needed)
    unsigned char signature[64];

    ed25519_sign(signature,
                 (const unsigned char*)data.c_str(), data.length(),
                 ed25519PublicKey, ed25519PrivateKey);

    Serial.printf("[CRYPTO] Signature len: 64\n");
    return base64UrlEncode(signature, 64);
}

// ==================== WiFi ====================

void connectWiFi() {
    Serial.println("[WiFi] Connecting to: " + String(WIFI_SSID));
    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

    int attempts = 0;
    while (WiFi.status() != WL_CONNECTED && attempts < 30) {
        delay(500);
        Serial.print(".");
        attempts++;
    }
    Serial.println();

    if (WiFi.status() == WL_CONNECTED) {
        Serial.println("[WiFi] Connected!");
        Serial.println("[WiFi] IP: " + WiFi.localIP().toString());

        // Configure NTP time and wait for sync
        Serial.println("[NTP] Syncing time...");
        configTime(8 * 3600, 0, "pool.ntp.org", "time.nist.gov");

        // Wait for NTP sync (max 10 seconds)
        int ntpAttempts = 0;
        struct tm timeInfo;
        while (!getLocalTime(&timeInfo) && ntpAttempts < 20) {
            delay(500);
            ntpAttempts++;
            Serial.print(".");
        }
        if (getLocalTime(&timeInfo)) {
            Serial.println();
            Serial.println("[NTP] Time synced!");
            char timeStr[64];
            strftime(timeStr, sizeof(timeStr), "%Y-%m-%d %H:%M:%S", &timeInfo);
            Serial.println("[NTP] Current time: " + String(timeStr));
        } else {
            Serial.println();
            Serial.println("[NTP] Warning: Time sync failed, using millis() fallback");
        }
    } else {
        Serial.println("[WiFi] Failed!");
    }
    Serial.flush();
}

// ==================== WebSocket ====================

bool connectWebSocket() {
    Serial.println("[WS] Connecting to " + String(GATEWAY_HOST) + ":" + String(GATEWAY_PORT));
    Serial.flush();

    if (wifiClient.connected()) {
        wifiClient.stop();
        delay(100);
    }

    if (!wifiClient.connect(GATEWAY_HOST, GATEWAY_PORT, 5000)) {
        Serial.println("[WS] TCP connection failed!");
        return false;
    }

    Serial.println("[WS] TCP connected, doing handshake...");

    // Generate random WebSocket key using ESP32 hardware RNG
    uint8_t randomBytes[16];
    for (int i = 0; i < 16; i++) {
        randomBytes[i] = (uint8_t)(esp_random() & 0xFF);
    }
    String wsKey = base64Encode(randomBytes, 16);  // Use standard base64 for WebSocket handshake

    String request = "GET /ws HTTP/1.1\r\n";
    request += "Host: " + String(GATEWAY_HOST) + ":" + String(GATEWAY_PORT) + "\r\n";
    request += "Upgrade: websocket\r\n";
    request += "Connection: Upgrade\r\n";
    request += "Sec-WebSocket-Key: " + wsKey + "\r\n";
    request += "Sec-WebSocket-Version: 13\r\n";
    request += "Sec-WebSocket-Protocol: openclaw\r\n";
    request += "\r\n";

    wifiClient.print(request);
    wifiClient.flush();

    // Read HTTP response headers only (stop at \r\n\r\n)
    String response = "";
    unsigned long timeout = millis() + 3000;
    bool headersComplete = false;

    while (millis() < timeout && !headersComplete) {
        while (wifiClient.available() && !headersComplete) {
            char c = wifiClient.read();
            response += c;
            if (response.endsWith("\r\n\r\n")) {
                headersComplete = true;
            }
        }
        delay(10);
    }

    if (response.indexOf("101") > 0 && headersComplete) {
        Serial.println("[WS] Handshake successful!");
        wsConnected = true;
        connectState = STATE_HANDSHAKE_DONE;
        // Don't clear buffer - challenge event may already be waiting
        Serial.println("[WS] Waiting for challenge...");
        return true;
    } else {
        Serial.println("[WS] Handshake failed!");
        Serial.println(response.substring(0, 200));
        wifiClient.stop();
        wsConnected = false;
        return false;
    }
}

void handleWebSocket() {
    if (!wsConnected || !wifiClient.connected()) {
        wsConnected = false;
        connectState = STATE_DISCONNECTED;
        return;
    }

    while (wifiClient.available() >= 2) {
        uint8_t firstByte = wifiClient.read();
        uint8_t secondByte = wifiClient.read();

        uint8_t opcode = firstByte & 0x0F;
        bool masked = (secondByte & 0x80) != 0;
        uint64_t payloadLen = secondByte & 0x7F;

        if (payloadLen == 126) {
            uint8_t b1 = wifiClient.read();
            uint8_t b2 = wifiClient.read();
            payloadLen = (b1 << 8) | b2;
        } else if (payloadLen == 127) {
            for (int i = 0; i < 8; i++) wifiClient.read();
            payloadLen = 0;
        }

        uint8_t maskKey[4] = {0};
        if (masked) {
            for (int i = 0; i < 4; i++) {
                maskKey[i] = wifiClient.read();
            }
        }

        String data = "";
        for (uint64_t i = 0; i < payloadLen && wifiClient.available(); i++) {
            uint8_t b = wifiClient.read();
            if (masked) {
                b = b ^ maskKey[i % 4];
            }
            data += (char)b;
        }

        if (opcode == 0x08) {
            Serial.println("[WS] Close frame");
            disconnectWebSocket();
            return;
        } else if (opcode == 0x09) {
            uint8_t pong[2] = {0x8A, 0x00};
            wifiClient.write(pong, 2);
            continue;
        } else if (opcode == 0x01 || opcode == 0x02) {
            if (data.length() > 0) {
                parseMessage(data);
            }
        }
    }

    if (wsConnected && millis() - lastPing > 30000) {
        lastPing = millis();
        uint8_t ping[2] = {0x89, 0x00};
        wifiClient.write(ping, 2);
    }
}

void disconnectWebSocket() {
    if (wifiClient.connected()) {
        uint8_t closeFrame[4] = {0x88, 0x02, 0x03, 0xE8};
        wifiClient.write(closeFrame, 4);
        delay(100);
        wifiClient.stop();
    }
    wsConnected = false;
    connectState = STATE_DISCONNECTED;
    waitingForApproval = false;
    Serial.println("[WS] Disconnected");
}

// ==================== WS Frame sending ====================

void sendWSFrame(String data, bool isText) {
    if (!wifiClient.connected()) return;

    uint8_t mask[4];
    for (int i = 0; i < 4; i++) {
        mask[i] = (uint8_t)(esp_random() & 0xFF);
    }

    int dataLen = data.length();
    uint8_t header[14];
    int headerLen = 0;

    header[headerLen++] = isText ? 0x81 : 0x82;

    if (dataLen < 126) {
        header[headerLen++] = 0x80 | (uint8_t)dataLen;
    } else if (dataLen < 65536) {
        header[headerLen++] = 0x80 | 126;
        header[headerLen++] = (dataLen >> 8) & 0xFF;
        header[headerLen++] = dataLen & 0xFF;
    } else {
        header[headerLen++] = 0x80 | 127;
        for (int i = 0; i < 8; i++) header[headerLen++] = 0;
    }

    for (int i = 0; i < 4; i++) {
        header[headerLen++] = mask[i];
    }

    wifiClient.write(header, headerLen);

    for (int i = 0; i < dataLen; i++) {
        uint8_t masked = data.charAt(i) ^ mask[i % 4];
        wifiClient.write(masked);
    }

    wifiClient.flush();
}

void sendRequest(const char* method, String params) {
    String id = generateUUID();
    String json = "{\"type\":\"req\",\"id\":\"" + id + "\",\"method\":\"" + method + "\"";
    if (params.length() > 0) {
        json += ",\"params\":" + params;
    }
    json += "}";
    Serial.println("[WS->] " + json);
    sendWSFrame(json);
}

void sendResponse(String invokeId, bool ok, String payload) {
    // Send node.invoke.result method call as required by Gateway
    // Note: Gateway requires top-level 'id' for request frames
    String json = "{\"type\":\"req\",\"id\":\"" + invokeId + "\",\"method\":\"node.invoke.result\",\"params\":{\"id\":\"" + invokeId + "\",\"nodeId\":\"" + deviceId + "\",\"ok\":" + (ok ? "true" : "false");
    if (payload.length() > 0) {
        json += ",\"payload\":" + payload;
    }
    json += "}}";
    Serial.println("[WS->] " + json);
    sendWSFrame(json);
}

void sendEvent(const char* eventName, String payload) {
    String json = "{\"type\":\"event\",\"event\":\"" + String(eventName) + "\"";
    if (payload.length() > 0) {
        json += ",\"payload\":" + payload;
    }
    json += "}";
    Serial.println("[WS->] " + json);
    sendWSFrame(json);
}

// ==================== Message parsing ====================

void parseMessage(String msg) {
    Serial.println("[WS<-] " + msg);

    if (msg.indexOf("\"type\":\"event\"") > 0) {
        // Search for the event key with comma prefix to avoid matching "type":"event" value
        int eventStart = msg.indexOf(",\"event\":\"");
        if (eventStart > 0) {
            eventStart += 10;  // Skip past ,"event":"
            int eventEnd = msg.indexOf("\"", eventStart);
            String eventName = msg.substring(eventStart, eventEnd);

            Serial.println("[EVENT] " + eventName);

            if (eventName == "connect.challenge") {
                int nonceStart = msg.indexOf("\"nonce\":\"");
                if (nonceStart > 0) {
                    nonceStart += 9;
                    int nonceEnd = msg.indexOf("\"", nonceStart);
                    String nonce = msg.substring(nonceStart, nonceEnd);
                    handleConnectChallenge(nonce);
                }
            }
            else if (eventName == "connect.resolved") {
                bool success = msg.indexOf("\"success\":true") > 0;
                handleConnectResolved(success, msg);
            }
            else if (eventName == "node.pair.resolved") {
                int decisionStart = msg.indexOf("\"decision\":\"");
                if (decisionStart > 0) {
                    decisionStart += 12;
                    int decisionEnd = msg.indexOf("\"", decisionStart);
                    String decision = msg.substring(decisionStart, decisionEnd);

                    String token = "";
                    int tokenStart = msg.indexOf("\"token\":\"");
                    if (tokenStart > 0) {
                        tokenStart += 9;
                        int tokenEnd = msg.indexOf("\"", tokenStart);
                        token = msg.substring(tokenStart, tokenEnd);
                    }

                    handlePairResolved(decision, token);
                }
            }
            else if (eventName == "tick") {
                lastPing = millis();
            }
            else if (eventName == "node.invoke.request") {
                Serial.println("[INVOKE] Received invoke request!");
                // Parse from payload
                int payloadStart = msg.indexOf("\"payload\":");
                Serial.println("[INVOKE] payloadStart=" + String(payloadStart));
                if (payloadStart > 0) {
                    String payloadStr = msg.substring(payloadStart + 10);
                    Serial.println("[INVOKE] payloadStr=" + payloadStr);

                    String id = "";
                    String command = "";
                    String paramsJSON = "";

                    int idStart = payloadStr.indexOf("\"id\":\"");
                    if (idStart > 0) {
                        idStart += 6;
                        int idEnd = payloadStr.indexOf("\"", idStart);
                        id = payloadStr.substring(idStart, idEnd);
                    }

                    int cmdStart = payloadStr.indexOf("\"command\":\"");
                    if (cmdStart > 0) {
                        cmdStart += 11;
                        int cmdEnd = payloadStr.indexOf("\"", cmdStart);
                        command = payloadStr.substring(cmdStart, cmdEnd);
                    }

                    int paramsStart = payloadStr.indexOf("\"paramsJSON\":");
                    Serial.println("[INVOKE] paramsStart=" + String(paramsStart));
                    if (paramsStart > 0) {
                        // Check if value is null or a string
                        int valueStart = paramsStart + 13;  // Skip "paramsJSON":
                        // Skip whitespace
                        while (valueStart < payloadStr.length() && (payloadStr.charAt(valueStart) == ' ' || payloadStr.charAt(valueStart) == '\t')) {
                            valueStart++;
                        }
                        if (valueStart < payloadStr.length() && payloadStr.charAt(valueStart) == '"') {
                            // It's a string
                            valueStart++;  // Skip opening quote
                            int paramsEnd = payloadStr.indexOf("\"", valueStart);
                            paramsJSON = payloadStr.substring(valueStart, paramsEnd);
                            paramsJSON.replace("\\\"", "\"");
                            paramsJSON.replace("\\\\", "\\");
                        }
                        // If null, paramsJSON stays empty
                    }

                    Serial.println("[INVOKE] Parsed id=" + id + " command=" + command);
                    handleInvokeRequest(id, command, paramsJSON);
                } else {
                    Serial.println("[INVOKE] No payload found!");
                }
            }
        }
    }
}

// ==================== Auth handlers ====================

void handleConnectChallenge(String nonce) {
    Serial.println("[AUTH] Challenge nonce: " + nonce);
    wsNonce = nonce;
    connectState = STATE_WAITING_CHALLENGE;
    sendConnectRequest();
}

void sendConnectRequest() {
    Serial.println("[AUTH] Sending connect request...");

    // Get time ONCE for both payload and device.signedAt to ensure consistency
    unsigned long long signedAtMs = 0;
    struct tm timeInfo;
    if (getLocalTime(&timeInfo)) {
        time_t now = mktime(&timeInfo);
        signedAtMs = (unsigned long long)now * 1000ULL;
    } else {
        signedAtMs = millis();
    }

    // Build auth payload with the same timestamp
    String token = paired ? nodeToken : String(GATEWAY_AUTH_TOKEN);
    String authPayload = "v3|";
    authPayload += deviceId + "|";
    authPayload += String(NODE_CLIENT_ID) + "|";
    authPayload += String(NODE_MODE) + "|";
    authPayload += String(NODE_ROLE) + "|";
    authPayload += String(NODE_SCOPE) + "|";
    authPayload += String(signedAtMs) + "|";
    authPayload += token + "|";
    authPayload += wsNonce + "|";
    authPayload += String(NODE_PLATFORM) + "|";
    authPayload += String(NODE_DEVICE_FAMILY);

    Serial.println("[AUTH] Payload: " + authPayload);
    Serial.println("[AUTH] Payload len: " + String(authPayload.length()));
    Serial.println("[AUTH] Timestamp: " + String(signedAtMs));

    String signature = "";
    if (keysInitialized) {
        signature = signData(authPayload);
        Serial.println("[AUTH] Signature: " + signature);
        Serial.println("[AUTH] Signature len: " + String(signature.length()));
    }


    String clientObj = "{";
    clientObj += "\"id\":\"" + String(NODE_CLIENT_ID) + "\",";
    clientObj += "\"displayName\":\"" + String(NODE_NAME) + "\",";
    clientObj += "\"version\":\"" + String(NODE_VERSION) + "\",";
    clientObj += "\"platform\":\"" + String(NODE_PLATFORM) + "\",";
    clientObj += "\"deviceFamily\":\"" + String(NODE_DEVICE_FAMILY) + "\",";
    clientObj += "\"mode\":\"" + String(NODE_MODE) + "\",";
    clientObj += "\"instanceId\":\"" + deviceId + "\"";
    clientObj += "}";

    String capsArray = "[";
    for (int i = 0; i < CAPS_COUNT; i++) {
        if (i > 0) capsArray += ",";
        capsArray += "\"" + String(NODE_CAPS[i]) + "\"";
    }
    capsArray += "]";

    String commandsArray = "[";
    for (int i = 0; i < COMMANDS_COUNT; i++) {
        if (i > 0) commandsArray += ",";
        commandsArray += "\"" + String(NODE_COMMANDS[i]) + "\"";
    }
    commandsArray += "]";

    String publicKeyEscaped = publicKeyPem;
    // 手动转义换行符和回车符
    publicKeyEscaped.replace("\n", "\\n");
    publicKeyEscaped.replace("\r", "");

    String deviceObj = "{";
    deviceObj += "\"id\":\"" + deviceId + "\",";
    deviceObj += "\"publicKey\":\"" + publicKeyEscaped + "\",";
    deviceObj += "\"signature\":\"" + signature + "\",";

    // Convert 64-bit to string properly
    char signedAtBuf[24];
    snprintf(signedAtBuf, sizeof(signedAtBuf), "%llu", signedAtMs);
    deviceObj += "\"signedAt\":" + String(signedAtBuf) + ",";

    deviceObj += "\"nonce\":\"" + wsNonce + "\"";
    deviceObj += "}";

    String authObj = "{";
    if (paired && nodeToken.length() > 0) {
        // Use device token when paired
        authObj += "\"token\":\"" + nodeToken + "\"";
    } else {
        // Use gateway auth token for initial pairing
        authObj += "\"token\":\"" + String(GATEWAY_AUTH_TOKEN) + "\"";
    }
    authObj += "}";

    String params = "{";
    params += "\"minProtocol\":" + String(PROTOCOL_VERSION) + ",";
    params += "\"maxProtocol\":" + String(PROTOCOL_VERSION) + ",";
    params += "\"client\":" + clientObj + ",";
    params += "\"caps\":" + capsArray + ",";
    params += "\"commands\":" + commandsArray + ",";
    params += "\"role\":\"" + String(NODE_ROLE) + "\",";
    params += "\"scopes\":[\"" + String(NODE_SCOPE) + "\"],";
    params += "\"device\":" + deviceObj + ",";
    params += "\"auth\":" + authObj;
    params += "}";

    Serial.println("[AUTH] Connect params: " + params);
    sendRequest("connect", params);
    connectState = STATE_AUTH_SENT;
    Serial.println("[AUTH] Connect request sent");
}

void handleConnectResolved(bool success, String payload) {
    if (success) {
        Serial.println("[AUTH] Connect SUCCESS");

        if (payload.indexOf("\"pairingRequired\":true") > 0 ||
            payload.indexOf("\"needsPairing\":true") > 0) {
            Serial.println("[PAIR] Pairing required, waiting...");
            waitingForApproval = true;
            blinkLED(5, 200);
        } else {
            paired = true;
            connectState = STATE_PAIRED;
            Serial.println("[AUTH] Authenticated!");
            blinkLED(3, 100);
        }

        int tokenStart = payload.indexOf("\"deviceToken\":\"");
        if (tokenStart > 0) {
            tokenStart += 15;
            int tokenEnd = payload.indexOf("\"", tokenStart);
            String newToken = payload.substring(tokenStart, tokenEnd);
            if (newToken.length() > 0) {
                savePairedToken(newToken.c_str());
            }
        }
    } else {
        Serial.println("[AUTH] Connect FAILED");
        Serial.println("[AUTH] Response: " + payload);

        if (payload.indexOf("auth") > 0 ||
            payload.indexOf("invalid") > 0 ||
            payload.indexOf("unauthorized") > 0) {
            clearPairedToken();
        }

        disconnectWebSocket();
    }
}

void handlePairResolved(String decision, String token) {
    Serial.println("[PAIR] Decision: " + decision);

    if (decision == "approved") {
        paired = true;
        waitingForApproval = false;
        connectState = STATE_PAIRED;

        if (token.length() > 0) {
            savePairedToken(token.c_str());
        }

        Serial.println("[PAIR] Approved!");
        blinkLED(3, 100);
    } else if (decision == "rejected") {
        Serial.println("[PAIR] Rejected");
        waitingForApproval = false;
        clearPairedToken();
        disconnectWebSocket();
    }
}

// ==================== Command handlers ====================

void handleInvokeRequest(String id, String command, String paramsJSON) {
    Serial.println("[INVOKE] id=" + id + " cmd=" + command);

    if (command == "sensor.read") {
        cmdSensorRead(id);
    } else if (command == "camera.snap") {
        cmdCameraSnap(id);
    } else if (command == "device.info") {
        cmdDeviceInfo(id);
    } else if (command == "system.notify") {
        String message = "";
        int msgStart = paramsJSON.indexOf("\"message\":\"");
        if (msgStart > 0) {
            msgStart += 11;
            int msgEnd = paramsJSON.indexOf("\"", msgStart);
            message = paramsJSON.substring(msgStart, msgEnd);
        }
        cmdSystemNotify(id, message);
    } else {
        sendResponse(id, false, "{\"error\":{\"code\":\"UNKNOWN_COMMAND\"}}");
    }
}

void cmdSensorRead(String reqId) {
    int rssi = WiFi.RSSI();
    unsigned long uptime = millis() / 1000;
    uint32_t freeHeap = ESP.getFreeHeap();

    String payload = "{";
    payload += "\"nodeId\":\"" + deviceId + "\",";
    payload += "\"rssi\":" + String(rssi) + ",";
    payload += "\"uptime\":" + String(uptime) + ",";
    payload += "\"freeHeap\":" + String(freeHeap) + ",";
    payload += "\"temperature\":25.5,";
    payload += "\"humidity\":65.0";
    payload += "}";

    if (reqId.length() > 0) {
        sendResponse(reqId, true, payload);
    } else {
        sendEvent("node.event", "{\"event\":\"sensor.data\",\"payload\":" + payload + "}");
    }
}

void cmdCameraSnap(String reqId) {
    String payload = "{\"success\":true,\"message\":\"Camera not implemented\"}";
    if (reqId.length() > 0) {
        sendResponse(reqId, true, payload);
    }
}

void cmdDeviceInfo(String reqId) {
    String payload = "{";
    payload += "\"nodeId\":\"" + deviceId + "\",";
    payload += "\"displayName\":\"" + String(NODE_NAME) + "\",";
    payload += "\"version\":\"" + String(NODE_VERSION) + "\",";
    payload += "\"platform\":\"" + String(NODE_PLATFORM) + "\",";
    payload += "\"ip\":\"" + WiFi.localIP().toString() + "\",";
    payload += "\"rssi\":" + String(WiFi.RSSI()) + ",";
    payload += "\"uptime\":" + String(millis() / 1000) + ",";
    payload += "\"freeHeap\":" + String(ESP.getFreeHeap()) + ",";
    payload += "\"paired\":" + String(paired ? "true" : "false");
    payload += "}";

    if (reqId.length() > 0) {
        sendResponse(reqId, true, payload);
    } else {
        sendEvent("node.event", "{\"event\":\"device.info\",\"payload\":" + payload + "}");
    }
}

void cmdSystemNotify(String reqId, String message) {
    Serial.println("[NOTIFY] " + message);
    blinkLED(3, 200);

    if (reqId.length() > 0) {
        sendResponse(reqId, true, "{\"success\":true}");
    }
}

// ==================== Utils ====================

void blinkLED(int times, int delayMs) {
    for (int i = 0; i < times; i++) {
        digitalWrite(NODE_LED_PIN, HIGH);
        delay(delayMs);
        digitalWrite(NODE_LED_PIN, LOW);
        delay(delayMs);
    }
}

String generateUUID() {
    uint8_t uuid[16];
    for (int i = 0; i < 16; i++) {
        uuid[i] = (char)('0' + (esp_random() >> 8) & 0xFF);
    }

    uuid[6] = (uuid[6] & 0x0F) | 0x40;
    uuid[8] = (uuid[8] & 0x3F) | 0x80;

    char buf[37];
    snprintf(buf, sizeof(buf),
             "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
             uuid[0], uuid[1], uuid[2], uuid[3],
             uuid[4], uuid[5],
             uuid[6], uuid[7],
             uuid[8], uuid[9],
             uuid[10], uuid[11], uuid[12], uuid[13], uuid[14], uuid[15]);

    return String(buf);
}
