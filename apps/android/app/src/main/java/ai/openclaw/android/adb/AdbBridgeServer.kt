package ai.openclaw.android.adb

import android.content.Context
import fi.iki.elonen.NanoHTTPD
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.BufferedReader
import java.io.InputStreamReader

/**
 * ADB Bridge Native - HTTP server pentru control tabletă
 * Folosește NanoHTTPD pentru compatibilitate Android
 * 
 * Endpoint-uri:
 * - GET  /adb/status      - Status serviciu
 * - POST /adb/shell       - Execută comandă shell
 * - POST /adb/tap         - Tap la coordonate
 * - POST /adb/swipe       - Swipe între coordonate  
 * - POST /adb/text        - Scrie text
 * - POST /adb/key         - Apasă tastă
 * - GET  /adb/screen      - Info ecran
 * 
 * Port: 8890
 */
class AdbBridgeServer(
    private val context: Context,
    private val port: Int = 8890
) : NanoHTTPD(port) {
    
    private val json = Json { prettyPrint = true }
    
    // API Key authentication (from BuildConfig or environment)
    private val apiKey = BuildConfig.ADB_BRIDGE_API_KEY.takeIf { it.isNotEmpty() } 
        ?: "adb-bridge-secure-key-${System.currentTimeMillis() % 10000}"
    
    @Serializable
    data class ShellCommandRequest(
        val command: String
    )
    
    @Serializable
    data class ShellCommandResponse(
        val success: Boolean,
        val stdout: String,
        val stderr: String,
        val exitCode: Int,
        val timestamp: Long = System.currentTimeMillis()
    )
    
    @Serializable
    data class TapRequest(val x: Int, val y: Int)
    
    @Serializable
    data class SwipeRequest(
        val x1: Int, val y1: Int,
        val x2: Int, val y2: Int,
        val duration: Int = 300
    )
    
    @Serializable
    data class TextRequest(val text: String)
    
    @Serializable
    data class KeyRequest(val keyCode: Int)
    
    @Serializable
    data class ScreenInfo(
        val width: Int,
        val height: Int,
        val density: Float,
        val rotation: Int
    )
    
    @Serializable
    data class AdbStatus(
        val status: String,
        val port: Int,
        val timestamp: Long = System.currentTimeMillis()
    )
    
    override fun serve(session: IHTTPSession): Response {
        val uri = session.uri
        val method = session.method
        
        // Skip auth for status, screen info, and OPTIONS
        val requiresAuth = when {
            uri == "/adb/status" && method == Method.GET -> false
            uri == "/adb/screen" && method == Method.GET -> false
            method == Method.OPTIONS -> false
            else -> true
        }
        
        // Check authentication for protected endpoints
        if (requiresAuth) {
            val apiKeyHeader = session.headers["x-api-key"] ?: session.headers["X-API-Key"]
            if (apiKeyHeader != apiKey) {
                return newFixedLengthResponse(
                    Response.Status.UNAUTHORIZED,
                    MIME_PLAINTEXT,
                    "{\"error\":\"Unauthorized: Invalid or missing API key\"}"
                )
            }
        }
        
        return try {
            when {
                uri == "/adb/status" && method == Method.GET ->
                    handleStatus()
                uri == "/adb/shell" && method == Method.POST ->
                    handleShell(session)
                uri == "/adb/tap" && method == Method.POST ->
                    handleTap(session)
                uri == "/adb/swipe" && method == Method.POST ->
                    handleSwipe(session)
                uri == "/adb/text" && method == Method.POST ->
                    handleText(session)
                uri == "/adb/key" && method == Method.POST ->
                    handleKey(session)
                uri == "/adb/screen" && method == Method.GET ->
                    handleScreenInfo()
                method == Method.OPTIONS ->
                    handleOptions()
                else ->
                    newFixedLengthResponse(
                        Response.Status.NOT_FOUND,
                        MIME_PLAINTEXT,
                        "{\"error\":\"Not Found\"}"
                    )
            }
        } catch (e: Exception) {
            android.util.Log.e("AdbBridge", "Error: ${e.message}")
            newFixedLengthResponse(
                Response.Status.INTERNAL_ERROR,
                MIME_PLAINTEXT,
                "{\"error\":\"${e.message}\"}"
            )
        }
    }
    
    private fun handleStatus(): Response {
        val status = AdbStatus(
            status = if (isAlive) "running" else "stopped",
            port = port
        )
        return newJsonResponse(status)
    }
    
    private fun handleShell(session: IHTTPSession): Response {
        return try {
            val bodyMap = HashMap<String, String>()
            session.parseBody(bodyMap)
            val body = bodyMap["postData"] ?: "{}"
            
            val request = json.decodeFromString<ShellCommandRequest>(body)
            val result = executeShell(request.command)
            
            newJsonResponse(result)
        } catch (e: Exception) {
            newFixedLengthResponse(
                Response.Status.BAD_REQUEST,
                MIME_PLAINTEXT,
                "{\"error\":\"${e.message}\"}"
            )
        }
    }
    
    private fun handleTap(session: IHTTPSession): Response {
        return try {
            val bodyMap = HashMap<String, String>()
            session.parseBody(bodyMap)
            val body = bodyMap["postData"] ?: "{}"
            
            val request = json.decodeFromString<TapRequest>(body)
            val success = simulateTap(request.x, request.y)
            
            newJsonResponse(mapOf("success" to success, "x" to request.x, "y" to request.y))
        } catch (e: Exception) {
            newFixedLengthResponse(
                Response.Status.BAD_REQUEST,
                MIME_PLAINTEXT,
                "{\"error\":\"${e.message}\"}"
            )
        }
    }
    
    private fun handleSwipe(session: IHTTPSession): Response {
        return try {
            val bodyMap = HashMap<String, String>()
            session.parseBody(bodyMap)
            val body = bodyMap["postData"] ?: "{}"
            
            val request = json.decodeFromString<SwipeRequest>(body)
            val success = simulateSwipe(
                request.x1, request.y1,
                request.x2, request.y2,
                request.duration
            )
            
            newJsonResponse(mapOf("success" to success))
        } catch (e: Exception) {
            newFixedLengthResponse(
                Response.Status.BAD_REQUEST,
                MIME_PLAINTEXT,
                "{\"error\":\"${e.message}\"}"
            )
        }
    }
    
    private fun handleText(session: IHTTPSession): Response {
        return try {
            val bodyMap = HashMap<String, String>()
            session.parseBody(bodyMap)
            val body = bodyMap["postData"] ?: "{}"
            
            val request = json.decodeFromString<TextRequest>(body)
            val success = inputText(request.text)
            
            newJsonResponse(mapOf("success" to success, "text" to request.text))
        } catch (e: Exception) {
            newFixedLengthResponse(
                Response.Status.BAD_REQUEST,
                MIME_PLAINTEXT,
                "{\"error\":\"${e.message}\"}"
            )
        }
    }
    
    private fun handleKey(session: IHTTPSession): Response {
        return try {
            val bodyMap = HashMap<String, String>()
            session.parseBody(bodyMap)
            val body = bodyMap["postData"] ?: "{}"
            
            val request = json.decodeFromString<KeyRequest>(body)
            val success = pressKey(request.keyCode)
            
            newJsonResponse(mapOf("success" to success, "keyCode" to request.keyCode))
        } catch (e: Exception) {
            newFixedLengthResponse(
                Response.Status.BAD_REQUEST,
                MIME_PLAINTEXT,
                "{\"error\":\"${e.message}\"}"
            )
        }
    }
    
    @Suppress("DEPRECATION")
    private fun handleScreenInfo(): Response {
        val display = context.resources.displayMetrics
        val windowManager = context.getSystemService(Context.WINDOW_SERVICE) as android.view.WindowManager
        val rotation = windowManager.defaultDisplay.rotation
        
        val info = ScreenInfo(
            width = display.widthPixels,
            height = display.heightPixels,
            density = display.density,
            rotation = rotation
        )
        
        return newJsonResponse(info)
    }
    
    private fun handleOptions(): Response {
        val response = newFixedLengthResponse(Response.Status.NO_CONTENT, "", "")
        response.addHeader("Access-Control-Allow-Origin", "*")
        response.addHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        response.addHeader("Access-Control-Allow-Headers", "Content-Type")
        return response
    }
    
    private fun executeShell(command: String): ShellCommandResponse {
        return try {
            val process = Runtime.getRuntime().exec(arrayOf("sh", "-c", command))
            
            val stdout = BufferedReader(InputStreamReader(process.inputStream)).use { it.readText() }
            val stderr = BufferedReader(InputStreamReader(process.errorStream)).use { it.readText() }
            
            val exitCode = process.waitFor()
            
            ShellCommandResponse(
                success = exitCode == 0,
                stdout = stdout,
                stderr = stderr,
                exitCode = exitCode
            )
        } catch (e: Exception) {
            ShellCommandResponse(
                success = false,
                stdout = "",
                stderr = e.message ?: "Unknown error",
                exitCode = -1
            )
        }
    }
    
    private fun simulateTap(x: Int, y: Int): Boolean {
        return try {
            Runtime.getRuntime().exec("input tap $x $y").waitFor() == 0
        } catch (e: Exception) {
            false
        }
    }
    
    private fun simulateSwipe(x1: Int, y1: Int, x2: Int, y2: Int, duration: Int): Boolean {
        return try {
            Runtime.getRuntime().exec("input swipe $x1 $y1 $x2 $y2 $duration").waitFor() == 0
        } catch (e: Exception) {
            false
        }
    }
    
    private fun inputText(text: String): Boolean {
        return try {
            val escaped = text.replace("\"", "\\\"").replace("'", "\\'")
            Runtime.getRuntime().exec("input text \"$escaped\"").waitFor() == 0
        } catch (e: Exception) {
            false
        }
    }
    
    private fun pressKey(keyCode: Int): Boolean {
        return try {
            Runtime.getRuntime().exec("input keyevent $keyCode").waitFor() == 0
        } catch (e: Exception) {
            false
        }
    }
    
    private fun newJsonResponse(data: Any): Response {
        val jsonString = when (data) {
            is String -> data
            else -> json.encodeToString(data)
        }
        val response = newFixedLengthResponse(Response.Status.OK, "application/json", jsonString)
        response.addHeader("Access-Control-Allow-Origin", "*")
        return response
    }
    
    companion object {
        const val KEY_HOME = 3
        const val KEY_BACK = 4
        const val KEY_VOLUME_UP = 24
        const val KEY_VOLUME_DOWN = 25
        const val KEY_POWER = 26
        const val KEY_ENTER = 66
        const val KEY_MENU = 82
    }
}