import SwiftUI
import WidgetKit

@main
struct OpenClawActivityWidgetBundle: WidgetBundle {
    var body: some Widget {
        OpenClawControlRoomWidget()
        OpenClawLiveActivity()
    }
}
