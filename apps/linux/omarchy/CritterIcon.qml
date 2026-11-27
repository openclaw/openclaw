import QtQuick

// Geometry adapted from OpenClaw's macOS CritterIconRenderer (18-point template).
// Eyes are transparent cutouts so the icon also works on a transparent bar.
Canvas {
  id: root
  property color foreground: "white"
  property bool animated: true
  property bool working: false
  property real blink: 0
  property real legs: 0
  property real antenna: 0
  implicitWidth: 18
  implicitHeight: 18
  onForegroundChanged: requestPaint()
  onBlinkChanged: requestPaint()
  onLegsChanged: requestPaint()
  onAntennaChanged: requestPaint()
  onWidthChanged: requestPaint()
  onHeightChanged: requestPaint()

  onPaint: {
    var c = getContext("2d")
    c.reset()
    c.clearRect(0, 0, width, height)
    c.save()
    c.scale(width / 18, height / 18)
    c.translate(0, 18)
    c.scale(1, -1)
    c.fillStyle = foreground
    c.strokeStyle = foreground
    c.lineWidth = 2.07
    c.lineCap = "round"
    for (var side of [-1, 1]) {
      c.beginPath()
      c.moveTo(9 + side * 2.0736, 13.437)
      c.quadraticCurveTo(9 + side * 2.8512, 16.65,
                        9 + side * 5.184 + side * antenna * 0.28,
                        16.38 + antenna * 0.2 * side)
      c.stroke()
    }
    function ellipse(x, y, w, h) {
      c.beginPath()
      c.ellipse(x, y, w, h)
      c.fill()
    }
    for (var side of [-1, 1]) {
      var lift = side * 1.134 * legs
      c.beginPath()
      c.roundedRect(9 + side * 2.34 - 1.26, 1.8 + lift, 2.52, 3.24, 1.26, 1.26)
      c.fill()
    }
    ellipse(0.9, 6.6096, 3.6, 3.6)
    ellipse(13.5, 6.6096, 3.6, 3.6)
    ellipse(2.52, 3.42, 12.96, 11.88)
    var eyeH = 3.0888 * Math.max(0.22, 1 - blink)
    c.globalCompositeOperation = "destination-out"
    for (var side of [-1, 1]) {
      ellipse(9 + side * 2.8512 - 1.4256, 10.3104 - eyeH / 2, 2.8512, eyeH)
    }
    c.globalCompositeOperation = "source-over"
    if (blink < 0.3) {
      for (var side of [-1, 1]) {
        ellipse(9 + side * 2.8512 - 1.3686, 10.1251, 1.4826, 1.4826)
      }
    }
    c.restore()
  }

  Timer {
    interval: 5500
    running: root.animated && root.visible
    repeat: true
    onTriggered: blinkMotion.restart()
  }
  Timer {
    interval: root.working ? 1600 : 9700
    running: root.animated && root.visible
    repeat: true
    onTriggered: wiggleMotion.restart()
  }
  SequentialAnimation {
    id: blinkMotion
    NumberAnimation { target: root; property: "blink"; to: 1; duration: 80; easing.type: Easing.InOutQuad }
    PauseAnimation { duration: 80 }
    NumberAnimation { target: root; property: "blink"; to: 0; duration: 120; easing.type: Easing.OutQuad }
  }
  SequentialAnimation {
    id: wiggleMotion
    ParallelAnimation {
      NumberAnimation { target: root; property: "rotation"; to: -4; duration: 180; easing.type: Easing.InOutQuad }
      NumberAnimation { target: root; property: "legs"; to: 0.7; duration: 140; easing.type: Easing.InOutQuad }
      NumberAnimation { target: root; property: "antenna"; to: 1.2; duration: 180; easing.type: Easing.InOutQuad }
    }
    PauseAnimation { duration: 180 }
    ParallelAnimation {
      NumberAnimation { target: root; property: "rotation"; to: 0; duration: 240; easing.type: Easing.OutBack }
      NumberAnimation { target: root; property: "legs"; to: 0; duration: 180; easing.type: Easing.OutQuad }
      NumberAnimation { target: root; property: "antenna"; to: 0; duration: 240; easing.type: Easing.OutBack }
    }
  }
}
