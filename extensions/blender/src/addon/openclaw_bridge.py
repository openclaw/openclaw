"""
OpenClaw Blender Bridge Addon
=============================
Install this as a Blender addon (Edit > Preferences > Add-ons > Install).
It starts a local HTTP server inside Blender that the OpenClaw gateway
communicates with to control Blender in real time.

Default port: 7428 (configurable in addon preferences).
"""

bl_info = {
    "name": "OpenClaw Bridge",
    "author": "OpenClaw",
    "version": (1, 0, 0),
    "blender": (4, 0, 0),
    "location": "System > OpenClaw Bridge",
    "description": "Local HTTP bridge that lets the OpenClaw AI gateway control Blender via the Python API",
    "category": "System",
}

import bpy
import json
import threading
import traceback
import io
import sys
import os
from http.server import BaseHTTPRequestHandler, HTTPServer
from contextlib import redirect_stdout, redirect_stderr


# ---------------------------------------------------------------------------
# Globals
# ---------------------------------------------------------------------------

_server: HTTPServer | None = None
_server_thread: threading.Thread | None = None
ADDON_VERSION = "1.0.0"


# ---------------------------------------------------------------------------
# Request handlers
# ---------------------------------------------------------------------------

class BlenderBridgeHandler(BaseHTTPRequestHandler):
    """Handles incoming JSON requests from the OpenClaw gateway."""

    def log_message(self, format, *args):
        # Suppress default noisy HTTP logging
        pass

    def send_json(self, status: int, data: dict):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_body(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def do_GET(self):
        if self.path == "/status":
            self.handle_status()
        elif self.path == "/scene":
            self.handle_scene()
        else:
            self.send_json(404, {"error": f"Unknown path: {self.path}"})

    def do_POST(self):
        try:
            body = self.read_body()
        except Exception as e:
            self.send_json(400, {"error": f"Invalid JSON body: {e}"})
            return

        if self.path == "/execute":
            self.handle_execute(body)
        elif self.path == "/render":
            self.handle_render(body)
        elif self.path == "/import":
            self.handle_import(body)
        elif self.path == "/export":
            self.handle_export(body)
        elif self.path == "/screenshot":
            self.handle_screenshot(body)
        else:
            self.send_json(404, {"error": f"Unknown path: {self.path}"})

    # -----------------------------------------------------------------------
    # Handlers
    # -----------------------------------------------------------------------

    def handle_status(self):
        self.send_json(200, {
            "running": True,
            "blenderVersion": ".".join(str(v) for v in bpy.app.version),
            "addonVersion": ADDON_VERSION,
            "activeFile": bpy.data.filepath or None,
        })

    def handle_scene(self):
        scene = bpy.context.scene
        objects = []
        for obj in scene.objects:
            mat_names = [m.name for m in obj.data.materials] if hasattr(obj.data, "materials") and obj.data.materials else []
            info = {
                "name": obj.name,
                "type": obj.type,
                "collection": obj.users_collection[0].name if obj.users_collection else "",
                "location": list(obj.location),
                "rotation": list(obj.rotation_euler),
                "scale": list(obj.scale),
                "visible": obj.visible_get(),
                "materials": mat_names,
            }
            if obj.type == "MESH" and obj.data:
                info["vertexCount"] = len(obj.data.vertices)
                info["faceCount"] = len(obj.data.polygons)
            objects.append(info)

        self.send_json(200, {
            "name": scene.name,
            "objects": objects,
            "collections": [c.name for c in bpy.data.collections],
            "activeCamera": scene.camera.name if scene.camera else None,
            "renderEngine": scene.render.engine,
            "frameStart": scene.frame_start,
            "frameEnd": scene.frame_end,
            "fps": scene.render.fps,
        })

    def handle_execute(self, body: dict):
        code = body.get("code", "")
        if not code:
            self.send_json(400, {"error": "No code provided"})
            return

        stdout_capture = io.StringIO()
        result_value = None
        error_msg = None

        def _run():
            nonlocal result_value, error_msg
            try:
                local_ns: dict = {}
                with redirect_stdout(stdout_capture), redirect_stderr(stdout_capture):
                    exec(compile(code, "<openclaw>", "exec"), local_ns)
                result_value = local_ns.get("_result", None)
            except Exception:
                error_msg = traceback.format_exc()

        # Execute on the main thread via bpy.app.timers to avoid threading issues
        completed = _run_on_main_thread(_run)

        if not completed:
            self.send_json(200, {"ok": False, "error": "Timed out waiting for Blender main thread (300s)"})
        elif error_msg:
            self.send_json(200, {"ok": False, "error": error_msg, "output": stdout_capture.getvalue()})
        else:
            self.send_json(200, {
                "ok": True,
                "output": stdout_capture.getvalue(),
                "result": _safe_json(result_value),
            })

    def handle_render(self, body: dict):
        error_msg = None

        def _run():
            nonlocal error_msg
            try:
                scene = bpy.context.scene
                if body.get("engine"):
                    scene.render.engine = body["engine"]
                if body.get("resolutionX"):
                    scene.render.resolution_x = int(body["resolutionX"])
                if body.get("resolutionY"):
                    scene.render.resolution_y = int(body["resolutionY"])
                if body.get("samples"):
                    samples = int(body["samples"])
                    if scene.render.engine == "CYCLES":
                        scene.cycles.samples = samples
                    elif scene.render.engine == "BLENDER_EEVEE_NEXT":
                        scene.eevee.taa_render_samples = samples
                if body.get("camera"):
                    cam = bpy.data.objects.get(body["camera"])
                    if cam:
                        scene.camera = cam
                if body.get("outputPath"):
                    scene.render.filepath = body["outputPath"]
                frame_start = body.get("frameStart")
                frame_end = body.get("frameEnd")
                if frame_start is not None and frame_end is not None:
                    scene.frame_start = int(frame_start)
                    scene.frame_end = int(frame_end)
                    bpy.ops.render.render(animation=True)
                else:
                    bpy.ops.render.render(write_still=True)
            except Exception:
                error_msg = traceback.format_exc()

        completed = _run_on_main_thread(_run)

        if not completed:
            self.send_json(200, {"ok": False, "error": "Timed out waiting for Blender main thread (300s)"})
        elif error_msg:
            self.send_json(200, {"ok": False, "error": error_msg})
        else:
            self.send_json(200, {
                "ok": True,
                "outputPath": body.get("outputPath"),
            })

    def handle_import(self, body: dict):
        file_path = body.get("filePath", "")
        fmt = body.get("format", "").upper()
        collection_name = body.get("collection")
        error_msg = None

        def _run():
            nonlocal error_msg
            try:
                import_ops = {
                    "FBX": lambda: bpy.ops.import_scene.fbx(filepath=file_path),
                    "GLTF": lambda: bpy.ops.import_scene.gltf(filepath=file_path),
                    "GLB": lambda: bpy.ops.import_scene.gltf(filepath=file_path),
                    "OBJ": lambda: bpy.ops.wm.obj_import(filepath=file_path),
                    "USD": lambda: bpy.ops.wm.usd_import(filepath=file_path),
                    "USDC": lambda: bpy.ops.wm.usd_import(filepath=file_path),
                    "USDA": lambda: bpy.ops.wm.usd_import(filepath=file_path),
                    "ABC": lambda: bpy.ops.wm.alembic_import(filepath=file_path),
                    "STL": lambda: bpy.ops.wm.stl_import(filepath=file_path),
                    "PLY": lambda: bpy.ops.wm.ply_import(filepath=file_path),
                }
                op = import_ops.get(fmt)
                if not op:
                    raise ValueError(f"Unsupported format: {fmt}")
                op()

                if collection_name:
                    col = bpy.data.collections.get(collection_name)
                    if not col:
                        col = bpy.data.collections.new(collection_name)
                        bpy.context.scene.collection.children.link(col)
                    for obj in bpy.context.selected_objects:
                        for c in obj.users_collection:
                            c.objects.unlink(obj)
                        col.objects.link(obj)
            except Exception:
                error_msg = traceback.format_exc()

        completed = _run_on_main_thread(_run)

        if not completed:
            self.send_json(200, {"ok": False, "error": "Timed out waiting for Blender main thread (300s)"})
        elif error_msg:
            self.send_json(200, {"ok": False, "error": error_msg})
        else:
            self.send_json(200, {"ok": True})

    def handle_export(self, body: dict):
        file_path = body.get("filePath", "")
        fmt = body.get("format", "").upper()
        selection_only = bool(body.get("selectionOnly", False))
        apply_modifiers = bool(body.get("applyModifiers", True))
        export_animations = bool(body.get("exportAnimations", False))
        error_msg = None

        def _run():
            nonlocal error_msg
            try:
                if fmt == "FBX":
                    bpy.ops.export_scene.fbx(
                        filepath=file_path,
                        use_selection=selection_only,
                        use_mesh_modifiers=apply_modifiers,
                        bake_anim=export_animations,
                    )
                elif fmt in ("GLTF", "GLB"):
                    bpy.ops.export_scene.gltf(
                        filepath=file_path,
                        export_format="GLB" if fmt == "GLB" else "GLTF_EMBEDDED",
                        use_selection=selection_only,
                        export_apply=apply_modifiers,
                        export_animations=export_animations,
                    )
                elif fmt == "OBJ":
                    bpy.ops.wm.obj_export(
                        filepath=file_path,
                        export_selected_objects=selection_only,
                        apply_modifiers=apply_modifiers,
                    )
                elif fmt in ("USD", "USDC", "USDA"):
                    bpy.ops.wm.usd_export(
                        filepath=file_path,
                        selected_objects_only=selection_only,
                        export_animation=export_animations,
                    )
                elif fmt == "ABC":
                    bpy.ops.wm.alembic_export(
                        filepath=file_path,
                        selected=selection_only,
                    )
                else:
                    raise ValueError(f"Unsupported export format: {fmt}")
            except Exception:
                error_msg = traceback.format_exc()

        completed = _run_on_main_thread(_run)

        if not completed:
            self.send_json(200, {"ok": False, "error": "Timed out waiting for Blender main thread (300s)"})
        elif error_msg:
            self.send_json(200, {"ok": False, "error": error_msg})
        else:
            self.send_json(200, {"ok": True})

    def handle_screenshot(self, body: dict):
        import tempfile
        default_path = os.path.join(tempfile.gettempdir(), "openclaw_screenshot.png")
        output_path = body.get("outputPath") or default_path
        width = body.get("width")
        height = body.get("height")
        error_msg = None

        def _run():
            nonlocal error_msg
            try:
                scene = bpy.context.scene
                if width and height:
                    # Temporarily override render resolution so the offscreen
                    # screenshot honours the requested dimensions.
                    orig_x = scene.render.resolution_x
                    orig_y = scene.render.resolution_y
                    orig_pct = scene.render.resolution_percentage
                    scene.render.resolution_x = int(width)
                    scene.render.resolution_y = int(height)
                    scene.render.resolution_percentage = 100
                    try:
                        bpy.ops.screen.screenshot(filepath=output_path, full=False)
                    finally:
                        scene.render.resolution_x = orig_x
                        scene.render.resolution_y = orig_y
                        scene.render.resolution_percentage = orig_pct
                else:
                    bpy.ops.screen.screenshot(filepath=output_path, full=False)
            except Exception:
                error_msg = traceback.format_exc()

        completed = _run_on_main_thread(_run)

        if not completed:
            self.send_json(200, {"ok": False, "error": "Timed out waiting for Blender main thread (300s)"})
        elif error_msg:
            self.send_json(200, {"ok": False, "error": error_msg})
        else:
            self.send_json(200, {"ok": True, "outputPath": output_path})


# ---------------------------------------------------------------------------
# Thread-safe main-thread execution
# ---------------------------------------------------------------------------

_pending_fn = None
_pending_done = threading.Event()


def _run_on_main_thread(fn) -> bool:
    """Schedule fn to run on Blender's main thread and block until complete.

    Returns True if fn completed within the timeout, False if it timed out.
    """
    global _pending_fn, _pending_done
    _pending_fn = fn
    _pending_done.clear()
    bpy.app.timers.register(_execute_pending, first_interval=0.0)
    completed = _pending_done.wait(timeout=300)  # 5-minute timeout
    if not completed:
        # Timed out — cancel any still-pending work so the slot is not left dirty.
        _pending_fn = None
    return completed


def _execute_pending():
    global _pending_fn, _pending_done
    if _pending_fn:
        try:
            _pending_fn()
        finally:
            _pending_fn = None
            _pending_done.set()
    return None  # Don't reschedule


# ---------------------------------------------------------------------------
# JSON safety helper
# ---------------------------------------------------------------------------

def _safe_json(value):
    """Convert value to something JSON-serialisable."""
    try:
        json.dumps(value)
        return value
    except (TypeError, ValueError):
        return str(value)


# ---------------------------------------------------------------------------
# Server lifecycle
# ---------------------------------------------------------------------------

def start_server(host: str, port: int):
    global _server, _server_thread
    if _server is not None:
        return

    _server = HTTPServer((host, port), BlenderBridgeHandler)
    _server.timeout = 1.0

    def serve():
        print(f"[OpenClaw Bridge] Listening on http://{host}:{port}")
        while _server is not None:
            _server.handle_request()

    _server_thread = threading.Thread(target=serve, daemon=True, name="OpenClawBridge")
    _server_thread.start()


def stop_server():
    global _server, _server_thread
    if _server:
        _server.server_close()
        _server = None
        _server_thread = None
        print("[OpenClaw Bridge] Server stopped.")


# ---------------------------------------------------------------------------
# Addon preferences
# ---------------------------------------------------------------------------

class OpenClawBridgePreferences(bpy.types.AddonPreferences):
    bl_idname = __name__

    host: bpy.props.StringProperty(
        name="Host",
        description="Host to bind the HTTP server to",
        default="127.0.0.1",
    )  # type: ignore
    port: bpy.props.IntProperty(
        name="Port",
        description="Port for the OpenClaw Bridge HTTP server",
        default=7428,
        min=1024,
        max=65535,
    )  # type: ignore
    auto_start: bpy.props.BoolProperty(
        name="Auto-start on launch",
        description="Automatically start the bridge when Blender opens",
        default=True,
    )  # type: ignore

    def draw(self, context):
        layout = self.layout
        row = layout.row()
        row.prop(self, "host")
        row.prop(self, "port")
        layout.prop(self, "auto_start")

        status = "Running" if _server is not None else "Stopped"
        layout.label(text=f"Bridge status: {status}", icon="LINKED" if _server else "UNLINKED")

        row = layout.row()
        row.operator("openclaw.start_bridge", text="Start Bridge")
        row.operator("openclaw.stop_bridge", text="Stop Bridge")


# ---------------------------------------------------------------------------
# Operators
# ---------------------------------------------------------------------------

class OPENCLAW_OT_StartBridge(bpy.types.Operator):
    bl_idname = "openclaw.start_bridge"
    bl_label = "Start OpenClaw Bridge"
    bl_description = "Start the OpenClaw HTTP bridge server"

    def execute(self, context):
        prefs = context.preferences.addons[__name__].preferences
        start_server(prefs.host, prefs.port)
        self.report({"INFO"}, f"OpenClaw Bridge started on {prefs.host}:{prefs.port}")
        return {"FINISHED"}


class OPENCLAW_OT_StopBridge(bpy.types.Operator):
    bl_idname = "openclaw.stop_bridge"
    bl_label = "Stop OpenClaw Bridge"
    bl_description = "Stop the OpenClaw HTTP bridge server"

    def execute(self, context):
        stop_server()
        self.report({"INFO"}, "OpenClaw Bridge stopped")
        return {"FINISHED"}


# ---------------------------------------------------------------------------
# Status panel in the sidebar
# ---------------------------------------------------------------------------

class OPENCLAW_PT_BridgePanel(bpy.types.Panel):
    bl_label = "OpenClaw Bridge"
    bl_idname = "OPENCLAW_PT_bridge"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "OpenClaw"

    def draw(self, context):
        layout = self.layout
        prefs = context.preferences.addons[__name__].preferences
        status = "● Running" if _server is not None else "○ Stopped"
        col = layout.column()
        col.label(text=status, icon="LINKED" if _server else "UNLINKED")
        if _server is not None:
            col.label(text=f"http://{prefs.host}:{prefs.port}", icon="URL")
        row = col.row()
        row.operator("openclaw.start_bridge", text="Start")
        row.operator("openclaw.stop_bridge", text="Stop")


# ---------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------

classes = (
    OpenClawBridgePreferences,
    OPENCLAW_OT_StartBridge,
    OPENCLAW_OT_StopBridge,
    OPENCLAW_PT_BridgePanel,
)


def register():
    for cls in classes:
        bpy.utils.register_class(cls)

    # Auto-start if preference is set
    def _auto_start():
        prefs = bpy.context.preferences.addons.get(__name__)
        if prefs and prefs.preferences.auto_start:
            start_server(prefs.preferences.host, prefs.preferences.port)
        return None  # Don't reschedule

    bpy.app.timers.register(_auto_start, first_interval=0.5)


def unregister():
    stop_server()
    for cls in reversed(classes):
        bpy.utils.unregister_class(cls)


if __name__ == "__main__":
    register()
