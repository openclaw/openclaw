import CoreLocation
import Foundation
import OpenClawKit
import Testing
import UIKit
import UserNotifications
@testable import OpenClaw

private func withUserDefaults<T>(_ updates: [String: Any?], _ body: () throws -> T) rethrows -> T {
    let defaults = UserDefaults.standard
    var snapshot: [String: Any?] = [:]
    for key in updates.keys {
        snapshot[key] = defaults.object(forKey: key)
    }
    for (key, value) in updates {
        if let value {
            defaults.set(value, forKey: key)
        } else {
            defaults.removeObject(forKey: key)
        }
    }
    defer {
        for (key, value) in snapshot {
            if let value {
                defaults.set(value, forKey: key)
            } else {
                defaults.removeObject(forKey: key)
            }
        }
    }
    return try body()
}

private final class TestNotificationCenter: NotificationCentering, @unchecked Sendable {
    private(set) var requestAuthorizationCalls = 0
    private(set) var addedRequests: [UNNotificationRequest] = []
    private var status: NotificationAuthorizationStatus

    init(status: NotificationAuthorizationStatus) {
        self.status = status
    }

    func authorizationStatus() async -> NotificationAuthorizationStatus {
        status
    }

    func requestAuthorization(options: UNAuthorizationOptions) async throws -> Bool {
        requestAuthorizationCalls += 1
        status = .authorized
        return true
    }

    func add(_ request: UNNotificationRequest) async throws {
        addedRequests.append(request)
    }
}

private struct TestCameraService: CameraServicing {
    func listDevices() async -> [CameraController.CameraDeviceInfo] { [] }
    func snap(params: OpenClawCameraSnapParams) async throws -> (format: String, base64: String, width: Int, height: Int) {
        ("jpeg", "dGVzdA==", 1, 1)
    }
    func clip(params: OpenClawCameraClipParams) async throws -> (format: String, base64: String, durationMs: Int, hasAudio: Bool) {
        ("mp4", "dGVzdA==", 1000, true)
    }
}

private struct TestScreenRecorder: ScreenRecordingServicing {
    func record(
        screenIndex: Int?,
        durationMs: Int?,
        fps: Double?,
        includeAudio: Bool?,
        outPath: String?) async throws -> String
    {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("openclaw-screen-test.mp4")
        FileManager.default.createFile(atPath: url.path, contents: Data())
        return url.path
    }
}

@MainActor
private struct TestLocationService: LocationServicing {
    func authorizationStatus() -> CLAuthorizationStatus { .authorizedWhenInUse }
    func accuracyAuthorization() -> CLAccuracyAuthorization { .fullAccuracy }
    func ensureAuthorization(mode: OpenClawLocationMode) async -> CLAuthorizationStatus { .authorizedWhenInUse }
    func currentLocation(
        params: OpenClawLocationGetParams,
        desiredAccuracy: OpenClawLocationAccuracy,
        maxAgeMs: Int?,
        timeoutMs: Int?) async throws -> CLLocation
    {
        CLLocation(latitude: 37.3349, longitude: -122.0090)
    }
}

private struct TestDeviceStatusService: DeviceStatusServicing {
    let statusPayload: OpenClawDeviceStatusPayload
    let infoPayload: OpenClawDeviceInfoPayload

    func status() async throws -> OpenClawDeviceStatusPayload { statusPayload }
    func info() -> OpenClawDeviceInfoPayload { infoPayload }
}

private struct TestPhotosService: PhotosServicing {
    let payload: OpenClawPhotosLatestPayload
    func latest(params: OpenClawPhotosLatestParams) async throws -> OpenClawPhotosLatestPayload { payload }
}

private struct TestContactsService: ContactsServicing {
    let searchPayload: OpenClawContactsSearchPayload
    let addPayload: OpenClawContactsAddPayload
    func search(params: OpenClawContactsSearchParams) async throws -> OpenClawContactsSearchPayload { searchPayload }
    func add(params: OpenClawContactsAddParams) async throws -> OpenClawContactsAddPayload { addPayload }
}

private struct TestCalendarService: CalendarServicing {
    let eventsPayload: OpenClawCalendarEventsPayload
    let addPayload: OpenClawCalendarAddPayload
    func events(params: OpenClawCalendarEventsParams) async throws -> OpenClawCalendarEventsPayload { eventsPayload }
    func add(params: OpenClawCalendarAddParams) async throws -> OpenClawCalendarAddPayload { addPayload }
}

private struct TestRemindersService: RemindersServicing {
    let listPayload: OpenClawRemindersListPayload
    let addPayload: OpenClawRemindersAddPayload
    func list(params: OpenClawRemindersListParams) async throws -> OpenClawRemindersListPayload { listPayload }
    func add(params: OpenClawRemindersAddParams) async throws -> OpenClawRemindersAddPayload { addPayload }
}

private struct TestMotionService: MotionServicing {
    let activityPayload: OpenClawMotionActivityPayload
    let pedometerPayload: OpenClawPedometerPayload

    func activities(params: OpenClawMotionActivityParams) async throws -> OpenClawMotionActivityPayload {
        activityPayload
    }

    func pedometer(params: OpenClawPedometerParams) async throws -> OpenClawPedometerPayload {
        pedometerPayload
    }
}

@MainActor
private func makeTestAppModel(
    notificationCenter: NotificationCentering = TestNotificationCenter(status: .authorized),
    deviceStatusService: DeviceStatusServicing,
    photosService: PhotosServicing,
    contactsService: ContactsServicing,
    calendarService: CalendarServicing,
    remindersService: RemindersServicing,
    motionService: MotionServicing,
    talkMode: TalkModeManager = TalkModeManager(allowSimulatorCapture: true)) -> NodeAppModel
{
    NodeAppModel(
        screen: ScreenController(),
        camera: TestCameraService(),
        screenRecorder: TestScreenRecorder(),
        locationService: TestLocationService(),
        notificationCenter: notificationCenter,
        deviceStatusService: deviceStatusService,
        photosService: photosService,
        contactsService: contactsService,
        calendarService: calendarService,
        remindersService: remindersService,
        motionService: motionService,
        talkMode: talkMode)
}

@MainActor
private func makeTalkTestAppModel(talkMode: TalkModeManager) -> NodeAppModel {
    makeTestAppModel(
        deviceStatusService: TestDeviceStatusService(
            statusPayload: OpenClawDeviceStatusPayload(
                battery: OpenClawBatteryStatusPayload(level: 0.5, state: .unplugged, lowPowerModeEnabled: false),
                thermal: OpenClawThermalStatusPayload(state: .nominal),
                storage: OpenClawStorageStatusPayload(totalBytes: 10, freeBytes: 5, usedBytes: 5),
                network: OpenClawNetworkStatusPayload(
                    status: .satisfied,
                    isExpensive: false,
                    isConstrained: false,
                    interfaces: [.wifi]),
                uptimeSeconds: 1),
            infoPayload: OpenClawDeviceInfoPayload(
                deviceName: "Test",
                modelIdentifier: "Test1,1",
                systemName: "iOS",
                systemVersion: "1.0",
                appVersion: "dev",
                appBuild: "0",
                locale: "en-US")),
        photosService: TestPhotosService(payload: OpenClawPhotosLatestPayload(photos: [])),
        contactsService: TestContactsService(
            searchPayload: OpenClawContactsSearchPayload(contacts: []),
            addPayload: OpenClawContactsAddPayload(contact: OpenClawContactPayload(
                identifier: "c0",
                displayName: "",
                givenName: "",
                familyName: "",
                organizationName: "",
                phoneNumbers: [],
                emails: []))),
        calendarService: TestCalendarService(
            eventsPayload: OpenClawCalendarEventsPayload(events: []),
            addPayload: OpenClawCalendarAddPayload(event: OpenClawCalendarEventPayload(
                identifier: "e0",
                title: "Test",
                startISO: "2024-01-01T00:00:00Z",
                endISO: "2024-01-01T00:10:00Z",
                isAllDay: false,
                location: nil,
                calendarTitle: nil))),
        remindersService: TestRemindersService(
            listPayload: OpenClawRemindersListPayload(reminders: []),
            addPayload: OpenClawRemindersAddPayload(reminder: OpenClawReminderPayload(
                identifier: "r0",
                title: "Test",
                dueISO: nil,
                completed: false,
                listName: nil))),
        motionService: TestMotionService(
            activityPayload: OpenClawMotionActivityPayload(activities: []),
            pedometerPayload: OpenClawPedometerPayload(
                startISO: "2024-01-01T00:00:00Z",
                endISO: "2024-01-01T01:00:00Z",
                steps: nil,
                distanceMeters: nil,
                floorsAscended: nil,
                floorsDescended: nil)),
        talkMode: talkMode)
}

private func decodePayload<T: Decodable>(_ json: String?, as type: T.Type) throws -> T {
    let data = try #require(json?.data(using: .utf8))
    return try JSONDecoder().decode(type, from: data)
}

@Suite(.serialized) struct NodeAppModelInvokeTests {
    @Test @MainActor func decodeParamsFailsWithoutJSON() {
        #expect(throws: Error.self) {
            _ = try NodeAppModel._test_decodeParams(OpenClawCanvasNavigateParams.self, from: nil)
        }
    }

    @Test @MainActor func encodePayloadEmitsJSON() throws {
        struct Payload: Codable, Equatable {
            var value: String
        }
        let json = try NodeAppModel._test_encodePayload(Payload(value: "ok"))
        #expect(json.contains("\"value\""))
    }

    @Test @MainActor func handleInvokeRejectsBackgroundCommands() async {
        let appModel = NodeAppModel()
        appModel.setScenePhase(.background)

        let req = BridgeInvokeRequest(id: "bg", command: OpenClawCanvasCommand.present.rawValue)
        let res = await appModel._test_handleInvoke(req)
        #expect(res.ok == false)
        #expect(res.error?.code == .backgroundUnavailable)
    }

    @Test @MainActor func handleInvokeRejectsCameraWhenDisabled() async {
        let appModel = NodeAppModel()
        let req = BridgeInvokeRequest(id: "cam", command: OpenClawCameraCommand.snap.rawValue)

        let defaults = UserDefaults.standard
        let key = "camera.enabled"
        let previous = defaults.object(forKey: key)
        defaults.set(false, forKey: key)
        defer {
            if let previous {
                defaults.set(previous, forKey: key)
            } else {
                defaults.removeObject(forKey: key)
            }
        }

        let res = await appModel._test_handleInvoke(req)
        #expect(res.ok == false)
        #expect(res.error?.code == .unavailable)
        #expect(res.error?.message.contains("CAMERA_DISABLED") == true)
    }

    @Test @MainActor func handleInvokeRejectsInvalidScreenFormat() async {
        let appModel = NodeAppModel()
        let params = OpenClawScreenRecordParams(format: "gif")
        let data = try? JSONEncoder().encode(params)
        let json = data.flatMap { String(data: $0, encoding: .utf8) }

        let req = BridgeInvokeRequest(
            id: "screen",
            command: OpenClawScreenCommand.record.rawValue,
            paramsJSON: json)

        let res = await appModel._test_handleInvoke(req)
        #expect(res.ok == false)
        #expect(res.error?.message.contains("screen format must be mp4") == true)
    }

    @Test @MainActor func handleInvokeCanvasCommandsUpdateScreen() async throws {
        let appModel = NodeAppModel()
        appModel.screen.navigate(to: "http://example.com")

        let present = BridgeInvokeRequest(id: "present", command: OpenClawCanvasCommand.present.rawValue)
        let presentRes = await appModel._test_handleInvoke(present)
        #expect(presentRes.ok == true)
        #expect(appModel.screen.urlString.isEmpty)

        let navigateParams = OpenClawCanvasNavigateParams(url: "http://localhost:18789/")
        let navData = try JSONEncoder().encode(navigateParams)
        let navJSON = String(decoding: navData, as: UTF8.self)
        let navigate = BridgeInvokeRequest(
            id: "nav",
            command: OpenClawCanvasCommand.navigate.rawValue,
            paramsJSON: navJSON)
        let navRes = await appModel._test_handleInvoke(navigate)
        #expect(navRes.ok == true)
        #expect(appModel.screen.urlString == "http://localhost:18789/")

        let evalParams = OpenClawCanvasEvalParams(javaScript: "1+1")
        let evalData = try JSONEncoder().encode(evalParams)
        let evalJSON = String(decoding: evalData, as: UTF8.self)
        let eval = BridgeInvokeRequest(
            id: "eval",
            command: OpenClawCanvasCommand.evalJS.rawValue,
            paramsJSON: evalJSON)
        let evalRes = await appModel._test_handleInvoke(eval)
        #expect(evalRes.ok == true)
        let payloadData = try #require(evalRes.payloadJSON?.data(using: .utf8))
        let payload = try JSONSerialization.jsonObject(with: payloadData) as? [String: Any]
        #expect(payload?["result"] as? String == "2")

        let hide = BridgeInvokeRequest(id: "hide", command: OpenClawCanvasCommand.hide.rawValue)
        let hideRes = await appModel._test_handleInvoke(hide)
        #expect(hideRes.ok == true)
        #expect(appModel.screen.urlString.isEmpty)
    }

    @Test @MainActor func handleInvokeA2UICommandsFailWhenHostMissing() async throws {
        let appModel = NodeAppModel()

        let reset = BridgeInvokeRequest(id: "reset", command: OpenClawCanvasA2UICommand.reset.rawValue)
        let resetRes = await appModel._test_handleInvoke(reset)
        #expect(resetRes.ok == false)
        #expect(resetRes.error?.message.contains("A2UI_HOST_NOT_CONFIGURED") == true)

        let jsonl = "{\"beginRendering\":{}}"
        let pushParams = OpenClawCanvasA2UIPushJSONLParams(jsonl: jsonl)
        let pushData = try JSONEncoder().encode(pushParams)
        let pushJSON = String(decoding: pushData, as: UTF8.self)
        let push = BridgeInvokeRequest(
            id: "push",
            command: OpenClawCanvasA2UICommand.pushJSONL.rawValue,
            paramsJSON: pushJSON)
        let pushRes = await appModel._test_handleInvoke(push)
        #expect(pushRes.ok == false)
        #expect(pushRes.error?.message.contains("A2UI_HOST_NOT_CONFIGURED") == true)
    }

    @Test @MainActor func handleInvokeUnknownCommandReturnsInvalidRequest() async {
        let appModel = NodeAppModel()
        let req = BridgeInvokeRequest(id: "unknown", command: "nope")
        let res = await appModel._test_handleInvoke(req)
        #expect(res.ok == false)
        #expect(res.error?.code == .invalidRequest)
    }

    @Test @MainActor func handleInvokeSystemNotifyCreatesNotificationRequest() async throws {
        let notifier = TestNotificationCenter(status: .notDetermined)
        let deviceStatus = TestDeviceStatusService(
            statusPayload: OpenClawDeviceStatusPayload(
                battery: OpenClawBatteryStatusPayload(level: 0.5, state: .charging, lowPowerModeEnabled: false),
                thermal: OpenClawThermalStatusPayload(state: .nominal),
                storage: OpenClawStorageStatusPayload(totalBytes: 100, freeBytes: 50, usedBytes: 50),
                network: OpenClawNetworkStatusPayload(
                    status: .satisfied,
                    isExpensive: false,
                    isConstrained: false,
                    interfaces: [.wifi]),
                uptimeSeconds: 10),
            infoPayload: OpenClawDeviceInfoPayload(
                deviceName: "Test",
                modelIdentifier: "Test1,1",
                systemName: "iOS",
                systemVersion: "1.0",
                appVersion: "dev",
                appBuild: "0",
                locale: "en-US"))
        let emptyContact = OpenClawContactPayload(
            identifier: "c0",
            displayName: "",
            givenName: "",
            familyName: "",
            organizationName: "",
            phoneNumbers: [],
            emails: [])
        let emptyEvent = OpenClawCalendarEventPayload(
            identifier: "e0",
            title: "Test",
            startISO: "2024-01-01T00:00:00Z",
            endISO: "2024-01-01T00:30:00Z",
            isAllDay: false,
            location: nil,
            calendarTitle: nil)
        let emptyReminder = OpenClawReminderPayload(
            identifier: "r0",
            title: "Test",
            dueISO: nil,
            completed: false,
            listName: nil)
        let appModel = makeTestAppModel(
            notificationCenter: notifier,
            deviceStatusService: deviceStatus,
            photosService: TestPhotosService(payload: OpenClawPhotosLatestPayload(photos: [])),
            contactsService: TestContactsService(
                searchPayload: OpenClawContactsSearchPayload(contacts: []),
                addPayload: OpenClawContactsAddPayload(contact: emptyContact)),
            calendarService: TestCalendarService(
                eventsPayload: OpenClawCalendarEventsPayload(events: []),
                addPayload: OpenClawCalendarAddPayload(event: emptyEvent)),
            remindersService: TestRemindersService(
                listPayload: OpenClawRemindersListPayload(reminders: []),
                addPayload: OpenClawRemindersAddPayload(reminder: emptyReminder)),
            motionService: TestMotionService(
                activityPayload: OpenClawMotionActivityPayload(activities: []),
                pedometerPayload: OpenClawPedometerPayload(
                    startISO: "2024-01-01T00:00:00Z",
                    endISO: "2024-01-01T01:00:00Z",
                    steps: nil,
                    distanceMeters: nil,
                    floorsAscended: nil,
                    floorsDescended: nil)))

        let params = OpenClawSystemNotifyParams(title: "Hello", body: "World")
        let data = try JSONEncoder().encode(params)
        let json = String(decoding: data, as: UTF8.self)
        let req = BridgeInvokeRequest(
            id: "notify",
            command: OpenClawSystemCommand.notify.rawValue,
            paramsJSON: json)
        let res = await appModel._test_handleInvoke(req)
        #expect(res.ok == true)
        #expect(notifier.requestAuthorizationCalls == 1)
        #expect(notifier.addedRequests.count == 1)
        let request = try #require(notifier.addedRequests.first)
        #expect(request.content.title == "Hello")
        #expect(request.content.body == "World")
    }

    @Test @MainActor func handleInvokeDeviceAndDataCommandsReturnPayloads() async throws {
        let deviceStatusPayload = OpenClawDeviceStatusPayload(
            battery: OpenClawBatteryStatusPayload(level: 0.25, state: .unplugged, lowPowerModeEnabled: false),
            thermal: OpenClawThermalStatusPayload(state: .fair),
            storage: OpenClawStorageStatusPayload(totalBytes: 200, freeBytes: 80, usedBytes: 120),
            network: OpenClawNetworkStatusPayload(
                status: .satisfied,
                isExpensive: true,
                isConstrained: false,
                interfaces: [.cellular]),
            uptimeSeconds: 42)
        let deviceInfoPayload = OpenClawDeviceInfoPayload(
            deviceName: "TestPhone",
            modelIdentifier: "Test2,1",
            systemName: "iOS",
            systemVersion: "2.0",
            appVersion: "dev",
            appBuild: "1",
            locale: "en-US")
        let photosPayload = OpenClawPhotosLatestPayload(
            photos: [
                OpenClawPhotoPayload(format: "jpeg", base64: "dGVzdA==", width: 1, height: 1, createdAt: nil),
            ])
        let contactsPayload = OpenClawContactsSearchPayload(
            contacts: [
                OpenClawContactPayload(
                    identifier: "c1",
                    displayName: "Jane Doe",
                    givenName: "Jane",
                    familyName: "Doe",
                    organizationName: "",
                    phoneNumbers: ["+1"],
                    emails: ["jane@example.com"]),
            ])
        let contactsAddPayload = OpenClawContactsAddPayload(
            contact: OpenClawContactPayload(
                identifier: "c2",
                displayName: "Added",
                givenName: "Added",
                familyName: "",
                organizationName: "",
                phoneNumbers: ["+2"],
                emails: ["add@example.com"]))
        let calendarPayload = OpenClawCalendarEventsPayload(
            events: [
                OpenClawCalendarEventPayload(
                    identifier: "e1",
                    title: "Standup",
                    startISO: "2024-01-01T00:00:00Z",
                    endISO: "2024-01-01T00:30:00Z",
                    isAllDay: false,
                    location: nil,
                    calendarTitle: "Work"),
            ])
        let calendarAddPayload = OpenClawCalendarAddPayload(
            event: OpenClawCalendarEventPayload(
                identifier: "e2",
                title: "Added Event",
                startISO: "2024-01-02T00:00:00Z",
                endISO: "2024-01-02T01:00:00Z",
                isAllDay: false,
                location: "HQ",
                calendarTitle: "Work"))
        let remindersPayload = OpenClawRemindersListPayload(
            reminders: [
                OpenClawReminderPayload(
                    identifier: "r1",
                    title: "Ship build",
                    dueISO: "2024-01-02T00:00:00Z",
                    completed: false,
                    listName: "Inbox"),
            ])
        let remindersAddPayload = OpenClawRemindersAddPayload(
            reminder: OpenClawReminderPayload(
                identifier: "r2",
                title: "Added Reminder",
                dueISO: "2024-01-03T00:00:00Z",
                completed: false,
                listName: "Inbox"))
        let motionPayload = OpenClawMotionActivityPayload(
            activities: [
                OpenClawMotionActivityEntry(
                    startISO: "2024-01-01T00:00:00Z",
                    endISO: "2024-01-01T00:10:00Z",
                    confidence: "high",
                    isWalking: true,
                    isRunning: false,
                    isCycling: false,
                    isAutomotive: false,
                    isStationary: false,
                    isUnknown: false),
            ])
        let pedometerPayload = OpenClawPedometerPayload(
            startISO: "2024-01-01T00:00:00Z",
            endISO: "2024-01-01T01:00:00Z",
            steps: 123,
            distanceMeters: 456,
            floorsAscended: 1,
            floorsDescended: 2)

        let appModel = makeTestAppModel(
            deviceStatusService: TestDeviceStatusService(
                statusPayload: deviceStatusPayload,
                infoPayload: deviceInfoPayload),
            photosService: TestPhotosService(payload: photosPayload),
            contactsService: TestContactsService(
                searchPayload: contactsPayload,
                addPayload: contactsAddPayload),
            calendarService: TestCalendarService(
                eventsPayload: calendarPayload,
                addPayload: calendarAddPayload),
            remindersService: TestRemindersService(
                listPayload: remindersPayload,
                addPayload: remindersAddPayload),
            motionService: TestMotionService(
                activityPayload: motionPayload,
                pedometerPayload: pedometerPayload))

        let deviceStatusReq = BridgeInvokeRequest(id: "device", command: OpenClawDeviceCommand.status.rawValue)
        let deviceStatusRes = await appModel._test_handleInvoke(deviceStatusReq)
        #expect(deviceStatusRes.ok == true)
        let decodedDeviceStatus = try decodePayload(deviceStatusRes.payloadJSON, as: OpenClawDeviceStatusPayload.self)
        #expect(decodedDeviceStatus == deviceStatusPayload)

        let deviceInfoReq = BridgeInvokeRequest(id: "device-info", command: OpenClawDeviceCommand.info.rawValue)
        let deviceInfoRes = await appModel._test_handleInvoke(deviceInfoReq)
        #expect(deviceInfoRes.ok == true)
        let decodedDeviceInfo = try decodePayload(deviceInfoRes.payloadJSON, as: OpenClawDeviceInfoPayload.self)
        #expect(decodedDeviceInfo == deviceInfoPayload)

        let photosReq = BridgeInvokeRequest(id: "photos", command: OpenClawPhotosCommand.latest.rawValue)
        let photosRes = await appModel._test_handleInvoke(photosReq)
        #expect(photosRes.ok == true)
        let decodedPhotos = try decodePayload(photosRes.payloadJSON, as: OpenClawPhotosLatestPayload.self)
        #expect(decodedPhotos == photosPayload)

        let contactsReq = BridgeInvokeRequest(id: "contacts", command: OpenClawContactsCommand.search.rawValue)
        let contactsRes = await appModel._test_handleInvoke(contactsReq)
        #expect(contactsRes.ok == true)
        let decodedContacts = try decodePayload(contactsRes.payloadJSON, as: OpenClawContactsSearchPayload.self)
        #expect(decodedContacts == contactsPayload)

        let contactsAddParams = OpenClawContactsAddParams(
            givenName: "Added",
            phoneNumbers: ["+2"],
            emails: ["add@example.com"])
        let contactsAddData = try JSONEncoder().encode(contactsAddParams)
        let contactsAddReq = BridgeInvokeRequest(
            id: "contacts-add",
            command: OpenClawContactsCommand.add.rawValue,
            paramsJSON: String(decoding: contactsAddData, as: UTF8.self))
        let contactsAddRes = await appModel._test_handleInvoke(contactsAddReq)
        #expect(contactsAddRes.ok == true)
        let decodedContactsAdd = try decodePayload(contactsAddRes.payloadJSON, as: OpenClawContactsAddPayload.self)
        #expect(decodedContactsAdd == contactsAddPayload)

        let calendarReq = BridgeInvokeRequest(id: "calendar", command: OpenClawCalendarCommand.events.rawValue)
        let calendarRes = await appModel._test_handleInvoke(calendarReq)
        #expect(calendarRes.ok == true)
        let decodedCalendar = try decodePayload(calendarRes.payloadJSON, as: OpenClawCalendarEventsPayload.self)
        #expect(decodedCalendar == calendarPayload)

        let calendarAddParams = OpenClawCalendarAddParams(
            title: "Added Event",
            startISO: "2024-01-02T00:00:00Z",
            endISO: "2024-01-02T01:00:00Z",
            location: "HQ",
            calendarTitle: "Work")
        let calendarAddData = try JSONEncoder().encode(calendarAddParams)
        let calendarAddReq = BridgeInvokeRequest(
            id: "calendar-add",
            command: OpenClawCalendarCommand.add.rawValue,
            paramsJSON: String(decoding: calendarAddData, as: UTF8.self))
        let calendarAddRes = await appModel._test_handleInvoke(calendarAddReq)
        #expect(calendarAddRes.ok == true)
        let decodedCalendarAdd = try decodePayload(calendarAddRes.payloadJSON, as: OpenClawCalendarAddPayload.self)
        #expect(decodedCalendarAdd == calendarAddPayload)

        let remindersReq = BridgeInvokeRequest(id: "reminders", command: OpenClawRemindersCommand.list.rawValue)
        let remindersRes = await appModel._test_handleInvoke(remindersReq)
        #expect(remindersRes.ok == true)
        let decodedReminders = try decodePayload(remindersRes.payloadJSON, as: OpenClawRemindersListPayload.self)
        #expect(decodedReminders == remindersPayload)

        let remindersAddParams = OpenClawRemindersAddParams(
            title: "Added Reminder",
            dueISO: "2024-01-03T00:00:00Z",
            listName: "Inbox")
        let remindersAddData = try JSONEncoder().encode(remindersAddParams)
        let remindersAddReq = BridgeInvokeRequest(
            id: "reminders-add",
            command: OpenClawRemindersCommand.add.rawValue,
            paramsJSON: String(decoding: remindersAddData, as: UTF8.self))
        let remindersAddRes = await appModel._test_handleInvoke(remindersAddReq)
        #expect(remindersAddRes.ok == true)
        let decodedRemindersAdd = try decodePayload(remindersAddRes.payloadJSON, as: OpenClawRemindersAddPayload.self)
        #expect(decodedRemindersAdd == remindersAddPayload)

        let motionReq = BridgeInvokeRequest(id: "motion", command: OpenClawMotionCommand.activity.rawValue)
        let motionRes = await appModel._test_handleInvoke(motionReq)
        #expect(motionRes.ok == true)
        let decodedMotion = try decodePayload(motionRes.payloadJSON, as: OpenClawMotionActivityPayload.self)
        #expect(decodedMotion == motionPayload)

        let pedometerReq = BridgeInvokeRequest(id: "pedometer", command: OpenClawMotionCommand.pedometer.rawValue)
        let pedometerRes = await appModel._test_handleInvoke(pedometerReq)
        #expect(pedometerRes.ok == true)
        let decodedPedometer = try decodePayload(pedometerRes.payloadJSON, as: OpenClawPedometerPayload.self)
        #expect(decodedPedometer == pedometerPayload)
    }

    @Test @MainActor func handleInvokePushToTalkReturnsTranscriptStatus() async throws {
        let talkMode = TalkModeManager(allowSimulatorCapture: true)
        talkMode.updateGatewayConnected(false)
        let appModel = makeTalkTestAppModel(talkMode: talkMode)

        let startReq = BridgeInvokeRequest(id: "ptt-start", command: OpenClawTalkCommand.pttStart.rawValue)
        let startRes = await appModel._test_handleInvoke(startReq)
        #expect(startRes.ok == true)
        let startPayload = try decodePayload(startRes.payloadJSON, as: OpenClawTalkPTTStartPayload.self)
        #expect(!startPayload.captureId.isEmpty)

        talkMode._test_seedTranscript("Hello from PTT")

        let stopReq = BridgeInvokeRequest(id: "ptt-stop", command: OpenClawTalkCommand.pttStop.rawValue)
        let stopRes = await appModel._test_handleInvoke(stopReq)
        #expect(stopRes.ok == true)
        let stopPayload = try decodePayload(stopRes.payloadJSON, as: OpenClawTalkPTTStopPayload.self)
        #expect(stopPayload.captureId == startPayload.captureId)
        #expect(stopPayload.transcript == "Hello from PTT")
        #expect(stopPayload.status == "offline")
    }

    @Test @MainActor func handleInvokePushToTalkCancelStopsSession() async throws {
        let talkMode = TalkModeManager(allowSimulatorCapture: true)
        talkMode.updateGatewayConnected(false)
        let appModel = makeTalkTestAppModel(talkMode: talkMode)

        let startReq = BridgeInvokeRequest(id: "ptt-start", command: OpenClawTalkCommand.pttStart.rawValue)
        let startRes = await appModel._test_handleInvoke(startReq)
        #expect(startRes.ok == true)
        let startPayload = try decodePayload(startRes.payloadJSON, as: OpenClawTalkPTTStartPayload.self)

        let cancelReq = BridgeInvokeRequest(id: "ptt-cancel", command: OpenClawTalkCommand.pttCancel.rawValue)
        let cancelRes = await appModel._test_handleInvoke(cancelReq)
        #expect(cancelRes.ok == true)
        let cancelPayload = try decodePayload(cancelRes.payloadJSON, as: OpenClawTalkPTTStopPayload.self)
        #expect(cancelPayload.captureId == startPayload.captureId)
        #expect(cancelPayload.status == "cancelled")
    }

    @Test @MainActor func handleInvokePushToTalkOnceAutoStopsAfterSilence() async throws {
        let talkMode = TalkModeManager(allowSimulatorCapture: true)
        talkMode.updateGatewayConnected(false)
        let appModel = makeTalkTestAppModel(talkMode: talkMode)

        let onceReq = BridgeInvokeRequest(id: "ptt-once", command: OpenClawTalkCommand.pttOnce.rawValue)
        let onceTask = Task { await appModel._test_handleInvoke(onceReq) }

        for _ in 0..<5 where !talkMode.isPushToTalkActive {
            await Task.yield()
        }
        #expect(talkMode.isPushToTalkActive == true)

        talkMode._test_seedTranscript("Hello from PTT once")
        talkMode._test_backdateLastHeard(seconds: 1.0)
        await talkMode._test_runSilenceCheck()

        let onceRes = await onceTask.value
        #expect(onceRes.ok == true)
        let oncePayload = try decodePayload(onceRes.payloadJSON, as: OpenClawTalkPTTStopPayload.self)
        #expect(oncePayload.transcript == "Hello from PTT once")
        #expect(oncePayload.status == "offline")
    }

    @Test @MainActor func handleDeepLinkSetsErrorWhenNotConnected() async {
        let appModel = NodeAppModel()
        let url = URL(string: "openclaw://agent?message=hello")!
        await appModel.handleDeepLink(url: url)
        #expect(appModel.screen.errorText?.contains("Gateway not connected") == true)
    }

    @Test @MainActor func handleDeepLinkRejectsOversizedMessage() async {
        let appModel = NodeAppModel()
        let msg = String(repeating: "a", count: 20001)
        let url = URL(string: "openclaw://agent?message=\(msg)")!
        await appModel.handleDeepLink(url: url)
        #expect(appModel.screen.errorText?.contains("Deep link too large") == true)
    }

    @Test @MainActor func sendVoiceTranscriptThrowsWhenGatewayOffline() async {
        let appModel = NodeAppModel()
        await #expect(throws: Error.self) {
            try await appModel.sendVoiceTranscript(text: "hello", sessionKey: "main")
        }
    }

    @Test @MainActor func canvasA2UIActionDispatchesStatus() async {
        let appModel = NodeAppModel()
        let body: [String: Any] = [
            "userAction": [
                "name": "tap",
                "id": "action-1",
                "surfaceId": "main",
                "sourceComponentId": "button-1",
                "context": ["value": "ok"],
            ],
        ]
        await appModel._test_handleCanvasA2UIAction(body: body)
        #expect(appModel.screen.urlString.isEmpty)
    }
}
