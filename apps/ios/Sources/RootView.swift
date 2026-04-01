import SwiftUI
import UIKit

struct RootView: View {
    var body: some View {
        if UIDevice.current.userInterfaceIdiom == .pad {
            RootIPad()
        } else {
            RootCanvas()
        }
    }
}
