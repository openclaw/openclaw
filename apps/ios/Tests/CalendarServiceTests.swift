import Testing
@testable import OpenClaw

@Suite(.serialized) struct CalendarServiceTests {
    @Test func permissionRequestBoxResumesImmediatelyWhenCancelledBeforeInstall() async {
        let box = CalendarService._TestPermissionRequestBox()
        box.resume(false)
        let granted = await box.installAndAwait()
        #expect(granted == false)
    }

    @Test func permissionRequestBoxResumesInstalledContinuationOnce() async {
        let box = CalendarService._TestPermissionRequestBox()

        async let granted: Bool = box.installAndAwait()
        await Task.yield()
        box.resume(true)

        #expect(await granted == true)
    }
}
