import Foundation
import OpenClawChatUI
import Testing

struct OpenClawToastScheduleTests {
    private let start = ContinuousClock.now
    private let undo = OpenClawToast.Action(title: "Undo") {}

    @Test func `a plain toast leaves after two seconds`() {
        var schedule = OpenClawToastSchedule()
        schedule.post(.copied(), at: self.start, assistiveTechnologyRunning: false)

        do { let expired = schedule.expire(at: self.start + .milliseconds(1999))
            #expect(!expired)
        }
        #expect(schedule.current != nil)
        do { let expired = schedule.expire(at: self.start + .seconds(2))
            #expect(expired)
        }
        #expect(schedule.current == nil)
    }

    @Test func `a toast with an action leaves after five seconds`() {
        var schedule = OpenClawToastSchedule()
        schedule.post(OpenClawToast("Archived", action: self.undo), at: self.start, assistiveTechnologyRunning: false)

        do { let expired = schedule.expire(at: self.start + .milliseconds(4999))
            #expect(!expired)
        }
        do { let expired = schedule.expire(at: self.start + .seconds(5))
            #expect(expired)
        }
    }

    @Test func `a new toast replaces the current one and starts its own timer`() {
        var schedule = OpenClawToastSchedule()
        let first = schedule.post(.copied(), at: self.start, assistiveTechnologyRunning: false)
        let second = schedule.post(
            OpenClawToast("Archived", action: self.undo),
            at: self.start + .seconds(1),
            assistiveTechnologyRunning: false)

        #expect(second != first)
        #expect(schedule.current?.id == second)
        #expect(schedule.current?.toast.text == "Archived")
        // The first toast's two seconds no longer apply.
        do { let expired = schedule.expire(at: self.start + .seconds(2))
            #expect(!expired)
        }
        do { let expired = schedule.expire(at: self.start + .seconds(6))
            #expect(expired)
        }
    }

    @Test func `dismissing a replaced toast leaves the new one alone`() {
        var schedule = OpenClawToastSchedule()
        let first = schedule.post(.copied(), at: self.start, assistiveTechnologyRunning: false)
        let second = schedule.post(.copied("Path copied"), at: self.start, assistiveTechnologyRunning: false)

        schedule.dismiss(id: first)
        #expect(schedule.current?.id == second)
        schedule.dismiss(id: second)
        #expect(schedule.current == nil)
    }

    @Test func `a touch holds the timer and gives back the time left`() {
        var schedule = OpenClawToastSchedule()
        schedule.post(.copied(), at: self.start, assistiveTechnologyRunning: false)

        schedule.hold(at: self.start + .milliseconds(500))
        do { let expired = schedule.expire(at: self.start + .seconds(30))
            #expect(!expired)
        }

        schedule.release(at: self.start + .seconds(30))
        do { let expired = schedule.expire(at: self.start + .seconds(31))
            #expect(!expired)
        }
        do { let expired = schedule.expire(at: self.start + .milliseconds(31500))
            #expect(expired)
        }
    }

    @Test func `a toast posted under a finger waits for the finger to lift`() {
        var schedule = OpenClawToastSchedule()
        schedule.post(.copied(), at: self.start, assistiveTechnologyRunning: false)
        schedule.hold(at: self.start)
        schedule.post(.copied("Path copied"), at: self.start + .seconds(1), assistiveTechnologyRunning: false)

        do { let expired = schedule.expire(at: self.start + .seconds(10))
            #expect(!expired)
        }
        schedule.release(at: self.start + .seconds(10))
        do { let expired = schedule.expire(at: self.start + .seconds(12))
            #expect(expired)
        }
    }

    @Test func `with VoiceOver or Switch Control a toast with an action stays until dismissed`() {
        var schedule = OpenClawToastSchedule()
        let id = schedule.post(
            OpenClawToast("Archived", action: self.undo),
            at: self.start,
            assistiveTechnologyRunning: true)

        do { let expired = schedule.expire(at: self.start + .seconds(600))
            #expect(!expired)
        }
        schedule.dismiss(id: id)
        #expect(schedule.current == nil)
    }

    @Test func `with VoiceOver a toast without an action still leaves on time`() {
        #expect(OpenClawToastSchedule.lifetime(for: .copied(), assistiveTechnologyRunning: true) == .seconds(2))
    }

    @MainActor
    @Test func `the presenter runs the action once and dismisses the toast`() throws {
        @MainActor final class Counter { var runs = 0 }
        let counter = Counter()
        let presenter = OpenClawToastPresenter()
        presenter.post(OpenClawToast("Archived", action: .init(title: "Undo") { counter.runs += 1 }))
        let id = try #require(presenter.current?.id)

        presenter.performAction(id: id)
        presenter.performAction(id: id)

        #expect(counter.runs == 1)
        #expect(presenter.current == nil)
    }
}
