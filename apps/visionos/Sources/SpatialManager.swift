//
//  SpatialManager.swift
//  visionOS-node
//
//  OpenClaw visionOS Node — LOAM STUDIO
//
//  Manages ARKit data providers for spatial sensing.
//  Must be started from within an active ImmersiveSpace.
//
//  Providers implemented (Phase 3):
//    - HandTrackingProvider  → spatial.hands
//    - WorldTrackingProvider → device.position
//
//  Providers implemented (Phase 4):
//    - PlaneDetectionProvider  → spatial.planes
//
//  Providers implemented (Phase 5):
//    - SceneReconstructionProvider → spatial.mesh
//

import ARKit
import RealityKit
import QuartzCore
import simd

@MainActor
final class SpatialManager {

    private var session = ARKitSession()
    private var handTracking = HandTrackingProvider()
    private var worldTracking = WorldTrackingProvider()
    private var planeDetection = PlaneDetectionProvider(alignments: [.horizontal, .vertical])
    private var sceneReconstruction = SceneReconstructionProvider()

    private(set) var isRunning = false

    // Latest anchors — updated by the provider streams
    private var leftHand: HandAnchor?
    private var rightHand: HandAnchor?
    private var deviceAnchor: DeviceAnchor?
    private var detectedPlanes: [UUID: PlaneAnchor] = [:]
    private var meshAnchors: [UUID: MeshAnchor] = [:]

    // MARK: - Start (call from ImmersiveSpace .task)

    func start() async {
        guard HandTrackingProvider.isSupported else {
            print("[SpatialManager] HandTracking not supported on this device")
            return
        }

        // Explicitly request authorization before running — surfaces permission
        // dialogs and gives a clear error log if denied.
        print("[SpatialManager] Requesting ARKit authorization...")
        let authResult = await session.requestAuthorization(for: [.handTracking, .worldSensing])
        print("[SpatialManager] Auth result — handTracking: \(authResult[.handTracking] ?? .notDetermined), worldSensing: \(authResult[.worldSensing] ?? .notDetermined)")

        guard authResult[.handTracking] == .allowed, authResult[.worldSensing] == .allowed else {
            print("[SpatialManager] ⚠️ Authorization denied — handTracking: \(authResult[.handTracking] ?? .notDetermined), worldSensing: \(authResult[.worldSensing] ?? .notDetermined)")
            return
        }

        do {
            print("[SpatialManager] Starting ARKit session with hand + world + plane + mesh providers...")
            try await session.run([handTracking, worldTracking, planeDetection, sceneReconstruction])
            isRunning = true
            print("[SpatialManager] ✅ ARKit session running")
            await withTaskGroup(of: Void.self) { group in
                group.addTask { await self.processHandUpdates() }
                group.addTask { await self.processWorldUpdates() }
                group.addTask { await self.processPlaneUpdates() }
                group.addTask { await self.processMeshUpdates() }
            }
        } catch {
            print("[SpatialManager] ❌ ARKit session error: \(error)")
        }
    }

    func stop() {
        session.stop()
        isRunning = false
        // Reset session and providers so they can be reused on next start().
        // ARKit does not allow restarting a stopped session or re-running
        // a provider that has already been submitted — new instances are required.
        session = ARKitSession()
        handTracking = HandTrackingProvider()
        worldTracking = WorldTrackingProvider()
        planeDetection = PlaneDetectionProvider(alignments: [.horizontal, .vertical])
        sceneReconstruction = SceneReconstructionProvider()
    }

    // MARK: - Hand tracking stream

    private func processHandUpdates() async {
        for await update in handTracking.anchorUpdates {
            switch update.anchor.chirality {
            case .left:  leftHand  = update.anchor
            case .right: rightHand = update.anchor
            }
        }
    }

    // MARK: - World tracking stream

    private func processWorldUpdates() async {
        // WorldTrackingProvider does not have an anchorUpdates stream;
        // we query device position on demand via queryDeviceAnchor.
    }

    // MARK: - Plane detection stream

    private func processPlaneUpdates() async {
        for await update in planeDetection.anchorUpdates {
            let anchor = update.anchor
            switch update.event {
            case .added, .updated:
                detectedPlanes[anchor.id] = anchor
            case .removed:
                detectedPlanes.removeValue(forKey: anchor.id)
            }
        }
    }

    // MARK: - Scene reconstruction stream

    private func processMeshUpdates() async {
        for await update in sceneReconstruction.anchorUpdates {
            let anchor = update.anchor
            switch update.event {
            case .added, .updated:
                meshAnchors[anchor.id] = anchor
            case .removed:
                meshAnchors.removeValue(forKey: anchor.id)
            }
        }
    }

    // MARK: - Snapshots (called by NodeManager on node.invoke)

    /// Returns a JSON-serializable snapshot of both hands.
    func handsSnapshot() async -> [String: Any] {
        var result: [String: Any] = [:]

        if let left = leftHand {
            result["left"] = encodeHand(left)
        }
        if let right = rightHand {
            result["right"] = encodeHand(right)
        }
        result["timestamp"] = Date().timeIntervalSince1970

        return result
    }

    /// Returns the current head position/orientation.
    func devicePositionSnapshot() async -> [String: Any] {
        guard let anchor = worldTracking.queryDeviceAnchor(atTimestamp: CACurrentMediaTime()) else {
            return ["error": "device anchor unavailable"]
        }
        let transform = anchor.originFromAnchorTransform
        return [
            "transform": encodeMatrix(transform),
            "timestamp": Date().timeIntervalSince1970
        ]
    }

    /// Returns a JSON-serializable snapshot of all detected planes.
    func planesSnapshot() async -> [[String: Any]] {
        return detectedPlanes.values.map { anchor in
            [
                "id": anchor.id.uuidString,
                "alignment": encodePlaneAlignment(anchor.alignment),
                "classification": encodePlaneClassification(anchor.classification),
                "center": [anchor.originFromAnchorTransform.columns.3.x, anchor.originFromAnchorTransform.columns.3.y, anchor.originFromAnchorTransform.columns.3.z],
                "extent": [anchor.geometry.extent.width, anchor.geometry.extent.height],
                "transform": encodeMatrix(anchor.originFromAnchorTransform),
                "timestamp": Date().timeIntervalSince1970
            ]
        }
    }

    /// Returns a JSON-serializable snapshot of all scene reconstruction mesh chunks.
    func meshSnapshot() async -> [[String: Any]] {
        return meshAnchors.values.map { anchor in
            // Vertices: extract Float3 positions from GeometrySource
            var vertices: [[Float]] = []
            let vertexSource = anchor.geometry.vertices
            let vertexData = Data(buffer: UnsafeBufferPointer(
                start: vertexSource.buffer.contents().assumingMemoryBound(to: Float.self),
                count: vertexSource.count * vertexSource.componentsPerVector
            ))
            vertexData.withUnsafeBytes { raw in
                let floatBuffer = raw.baseAddress!.assumingMemoryBound(to: Float.self)
                for i in 0..<vertexSource.count {
                    let offset = i * vertexSource.stride / MemoryLayout<Float>.stride
                    vertices.append([floatBuffer[offset], floatBuffer[offset + 1], floatBuffer[offset + 2]])
                }
            }

            // Faces: extract UInt32 indices from GeometryElement
            var faces: [[Int]] = []
            let faceElement = anchor.geometry.faces
            let faceData = Data(buffer: UnsafeBufferPointer(
                start: faceElement.buffer.contents().assumingMemoryBound(to: UInt32.self),
                count: faceElement.count * 3
            ))
            faceData.withUnsafeBytes { raw in
                let idxBuffer = raw.baseAddress!.assumingMemoryBound(to: UInt32.self)
                for i in 0..<faceElement.count {
                    let base = i * 3
                    faces.append([Int(idxBuffer[base]), Int(idxBuffer[base + 1]), Int(idxBuffer[base + 2])])
                }
            }

            return [
                "id": anchor.id.uuidString,
                "transform": encodeMatrix(anchor.originFromAnchorTransform),
                "vertexCount": vertexSource.count,
                "faceCount": faceElement.count,
                "vertices": vertices,
                "faces": faces,
                "timestamp": Date().timeIntervalSince1970
            ]
        }
    }

    // MARK: - Serialization helpers

    private func encodeHand(_ anchor: HandAnchor) -> [String: Any] {
        var joints: [String: [String: Any]] = [:]

        for joint in HandSkeleton.JointName.allCases {
            if let j = anchor.handSkeleton?.joint(joint) {
                joints[joint.description] = [
                    "transform": encodeMatrix(j.anchorFromJointTransform),
                    "isTracked": j.isTracked
                ]
            }
        }

        return [
            "chirality": anchor.chirality == .left ? "left" : "right",
            "isTracked": anchor.isTracked,
            "originTransform": encodeMatrix(anchor.originFromAnchorTransform),
            "joints": joints
        ]
    }

    private func encodePlaneAlignment(_ alignment: PlaneAnchor.Alignment) -> String {
        switch alignment {
        case .horizontal: return "horizontal"
        case .vertical:   return "vertical"
        default:          return "arbitrary"
        }
    }

    private func encodePlaneClassification(_ classification: PlaneAnchor.Classification) -> String {
        switch classification {
        case .wall:    return "wall"
        case .floor:   return "floor"
        case .ceiling: return "ceiling"
        case .table:   return "table"
        case .seat:    return "seat"
        case .door:    return "door"
        case .window:  return "window"
        default:       return String(describing: classification)
        }
    }

    /// Flattens a simd_float4x4 to a 16-element array for JSON transport.
    private func encodeMatrix(_ m: simd_float4x4) -> [Float] {
        return [
            m.columns.0.x, m.columns.0.y, m.columns.0.z, m.columns.0.w,
            m.columns.1.x, m.columns.1.y, m.columns.1.z, m.columns.1.w,
            m.columns.2.x, m.columns.2.y, m.columns.2.z, m.columns.2.w,
            m.columns.3.x, m.columns.3.y, m.columns.3.z, m.columns.3.w
        ]
    }
}

// MARK: - HandSkeleton.JointName + description

extension HandSkeleton.JointName: CaseIterable {
    public static var allCases: [HandSkeleton.JointName] = [
        .wrist,
        .thumbKnuckle, .thumbIntermediateBase, .thumbIntermediateTip, .thumbTip,
        .indexFingerMetacarpal, .indexFingerKnuckle, .indexFingerIntermediateBase,
        .indexFingerIntermediateTip, .indexFingerTip,
        .middleFingerMetacarpal, .middleFingerKnuckle, .middleFingerIntermediateBase,
        .middleFingerIntermediateTip, .middleFingerTip,
        .ringFingerMetacarpal, .ringFingerKnuckle, .ringFingerIntermediateBase,
        .ringFingerIntermediateTip, .ringFingerTip,
        .littleFingerMetacarpal, .littleFingerKnuckle, .littleFingerIntermediateBase,
        .littleFingerIntermediateTip, .littleFingerTip,
        .forearmWrist
    ]

    var description: String {
        switch self {
        case .wrist: return "wrist"
        case .thumbKnuckle: return "thumbKnuckle"
        case .thumbIntermediateBase: return "thumbIntermediateBase"
        case .thumbIntermediateTip: return "thumbIntermediateTip"
        case .thumbTip: return "thumbTip"
        case .indexFingerMetacarpal: return "indexFingerMetacarpal"
        case .indexFingerKnuckle: return "indexFingerKnuckle"
        case .indexFingerIntermediateBase: return "indexFingerIntermediateBase"
        case .indexFingerIntermediateTip: return "indexFingerIntermediateTip"
        case .indexFingerTip: return "indexFingerTip"
        case .middleFingerMetacarpal: return "middleFingerMetacarpal"
        case .middleFingerKnuckle: return "middleFingerKnuckle"
        case .middleFingerIntermediateBase: return "middleFingerIntermediateBase"
        case .middleFingerIntermediateTip: return "middleFingerIntermediateTip"
        case .middleFingerTip: return "middleFingerTip"
        case .ringFingerMetacarpal: return "ringFingerMetacarpal"
        case .ringFingerKnuckle: return "ringFingerKnuckle"
        case .ringFingerIntermediateBase: return "ringFingerIntermediateBase"
        case .ringFingerIntermediateTip: return "ringFingerIntermediateTip"
        case .ringFingerTip: return "ringFingerTip"
        case .littleFingerMetacarpal: return "littleFingerMetacarpal"
        case .littleFingerKnuckle: return "littleFingerKnuckle"
        case .littleFingerIntermediateBase: return "littleFingerIntermediateBase"
        case .littleFingerIntermediateTip: return "littleFingerIntermediateTip"
        case .littleFingerTip: return "littleFingerTip"
        case .forearmWrist: return "forearmWrist"
        default: return "unknown"
        }
    }
}
