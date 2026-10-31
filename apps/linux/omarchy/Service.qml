import QtQuick
import Quickshell.Io

Item {
  id: root
  property var shell: null
  property var widgets: []
  property var snapshot: ({})
  property string routeId: ""
  property bool ready: false
  property bool desktop: false
  property bool yielded: false
  property string error: "Connecting to OpenClaw…"
  property var pending: ({})
  property int serial: 0
  property string refreshId: ""
  property bool stopping: false
  readonly property bool refreshing: refreshId !== ""
  readonly property string bridgePath: Qt.resolvedUrl("bridge.py").toString().replace(/^file:\/\//, "")
  signal result(var response)

  // One service spans every monitor. Yielding an icon keeps its registration so
  // the worker can notice the legacy app exit and restore the widget.
  function registerWidget(widget) {
    if (widgets.indexOf(widget) >= 0) return
    widgets = widgets.concat([widget])
    startWorker()
  }
  function unregisterWidget(widget) {
    widgets = widgets.filter(function(item) { return item !== widget })
    if (widgets.length === 0 && worker.running) {
      stopping = true
      worker.stdinEnabled = false
    }
  }
  function startWorker() {
    if (!widgets.length || worker.running || stopping) return
    worker.stdinEnabled = true
    worker.running = true
  }
  function request(message) {
    if (!worker.running || stopping) {
      error = "OpenClaw bridge is reconnecting. Try again when connected."
      return ""
    }
    var id = String(++serial)
    var request = Object.assign({}, message, {id: id})
    var next = Object.assign({}, pending)
    next[id] = {op: request.op, routeId: request.routeId}
    pending = next
    worker.write(JSON.stringify(request) + "\n")
    return id
  }
  function refresh() {
    if (!refreshId && routeId && !yielded) refreshId = request({op: "snapshot", routeId: routeId})
  }
  function receive(response) {
    if (response.op === "state") {
      var changed = routeId !== response.routeId
      if (changed) snapshot = ({})
      routeId = response.routeId || ""
      ready = response.ready === true
      desktop = response.desktop === true
      yielded = response.yield === true
      error = response.error || (ready ? "" : "Connecting to OpenClaw…")
      if (ready && (changed || !snapshot.ok)) refresh()
      return
    }
    var request = pending[response.id]
    if (!request) return
    var next = Object.assign({}, pending)
    delete next[response.id]
    pending = next
    if (response.id === refreshId) refreshId = ""
    if (response.op === "snapshot") {
      if (response.routeId !== routeId) { refresh(); return }
      if (response.ok) {
        snapshot = response
        error = ""
      } else {
        snapshot = Object.assign({}, snapshot, {ok: false})
        error = response.error || "Gateway unavailable. Open diagnostics."
      }
    }
    result(response)
  }
  Timer {
    interval: root.widgets.some(function(widget) { return widget.opened }) ? 10000 : 60000
    running: root.widgets.length > 0
    repeat: true
    onTriggered: root.refresh()
  }
  Timer {
    id: reconnect
    interval: 3000
    onTriggered: root.startWorker()
  }
  Process {
    id: worker
    command: ["python3", "-u", root.bridgePath, "--serve"]
    stdinEnabled: true
    stdout: SplitParser {
      onRead: function(line) {
        try { root.receive(JSON.parse(line)) }
        catch (e) { root.error = "Could not read OpenClaw bridge data. Open diagnostics." }
      }
    }
    onExited: function(code) {
      root.ready = false
      root.stopping = false
      root.error = "OpenClaw bridge disconnected. Reconnecting…"
      var pending = root.pending
      root.pending = ({})
      root.refreshId = ""
      // A terminated worker might have already sent the prompt. Never replay it.
      Object.keys(pending).forEach(function(id) {
        root.result({id: id, op: pending[id].op, routeId: pending[id].routeId,
          ok: false, uncertain: pending[id].op === "send",
          error: pending[id].op === "send"
            ? "Acceptance unknown. Check the session before sending again."
            : "OpenClaw bridge disconnected. Try again when connected."})
      })
      if (root.widgets.length) reconnect.restart()
    }
  }
}
