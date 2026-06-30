import UIKit

final class OpenClawNotchLogoView: UIView {
    private let imageView = UIImageView(image: UIImage(named: "OpenClawIcon"))

    override init(frame: CGRect) {
        super.init(frame: frame)
        self.isUserInteractionEnabled = false
        self.backgroundColor = .clear
        self.clipsToBounds = true
        self.imageView.contentMode = .scaleAspectFit
        self.imageView.isUserInteractionEnabled = false
        self.addSubview(self.imageView)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func layoutSubviews() {
        super.layoutSubviews()

        let iconSize = max(self.bounds.width, self.bounds.height)
        self.backgroundColor = .black
        self.imageView.frame = CGRect(
            x: (self.bounds.width - iconSize) / 2,
            y: -5,
            width: iconSize,
            height: iconSize)
    }
}
