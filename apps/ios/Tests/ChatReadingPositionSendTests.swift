import Testing
import UIKit
@testable import OpenClawChatUI

/// A send with the keyboard down holds the new turn (`.turn`). Its row's marker registers after
/// the layout pass that added the row; that pass found no row to place.
@MainActor
struct ChatReadingPositionSendTests {
    private final class Source: NSObject, UICollectionViewDataSource {
        let count: Int
        let marker: ChatReadingPosition.Marker

        init(count: Int, marker: ChatReadingPosition.Marker) {
            self.count = count
            self.marker = marker
        }

        func collectionView(_: UICollectionView, numberOfItemsInSection _: Int) -> Int {
            self.count
        }

        func collectionView(_ view: UICollectionView, cellForItemAt index: IndexPath) -> UICollectionViewCell {
            let cell = view.dequeueReusableCell(withReuseIdentifier: "row", for: index)
            if index.item == self.count - 1 { cell.contentView.addSubview(self.marker) }
            return cell
        }
    }

    @Test func `a sent turn whose row registers after the layout pass is placed in the next pass`() {
        let layout = UICollectionViewFlowLayout()
        layout.itemSize = CGSize(width: 393, height: 100)
        layout.minimumLineSpacing = 0
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
        let collection = UICollectionView(frame: window.bounds, collectionViewLayout: layout)
        collection.contentInsetAdjustmentBehavior = .never
        collection.register(UICollectionViewCell.self, forCellWithReuseIdentifier: "row")
        let position = ChatReadingPosition()
        // Reading, so attaching does not follow the bottom on its own.
        position.setMode(nil)
        let marker = ChatReadingPosition.Marker(frame: CGRect(x: 0, y: 0, width: 1, height: 1))
        marker.owner = position
        let source = Source(count: 30, marker: marker)
        collection.dataSource = source
        window.addSubview(collection)
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        collection.layoutIfNeeded()
        // The new last row (2900-3000) reaches just into the viewport, below where it belongs.
        collection.contentOffset.y = 2100
        collection.layoutIfNeeded()
        #expect(marker.window != nil)

        let turnID = UUID()
        position.setMode(.turn(turnID))
        collection.layoutIfNeeded()
        #expect(collection.contentOffset.y == 2100, "\(collection.contentOffset.y)")

        position.register(marker, key: .cell(.row(turnID)))
        collection.layoutIfNeeded()
        // Clamped to the end: the whole row sits above the bottom edge.
        #expect(abs(collection.contentOffset.y - (3000 - 852)) < 0.5)
    }
}
