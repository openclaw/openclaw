//! The web person card's horizontal placement, including its vertical fallback.
#[derive(Clone, Copy, Debug)]
pub struct Rect {
    pub left: f32,
    pub top: f32,
    pub width: f32,
    pub height: f32,
}

pub fn position(anchor: Rect, card: [f32; 2], viewport: [f32; 2]) -> [f32; 2] {
    let [width, height] = card;
    let [viewport_width, viewport_height] = viewport;
    let max_left = (viewport_width - width - 12.).max(12.);
    let max_top = (viewport_height - height - 12.).max(12.);
    let right = anchor.left + anchor.width;
    let bottom = anchor.top + anchor.height;
    let fits_below = bottom + 10. + height + 12. <= viewport_height;
    let fits_right = right + 10. + width + 12. <= viewport_width;
    let fits_left = anchor.left - 10. - width >= 12.;
    let fits_above = anchor.top - 10. - height >= 12.;
    let (left, top) = if fits_right || fits_left || (!fits_below && !fits_above) {
        (
            if fits_right {
                right + 10.
            } else {
                anchor.left - width - 10.
            },
            anchor.top,
        )
    } else {
        (
            anchor.left,
            if fits_below {
                bottom + 10.
            } else {
                anchor.top - height - 10.
            },
        )
    };
    [left.clamp(12., max_left), top.clamp(12., max_top)]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn person_cards_use_row_edge_then_flip_or_clamp_without_covering_a_fitting_axis() {
        let row = Rect {
            left: 10.,
            top: 330.,
            width: 232.,
            height: 30.,
        };
        assert_eq!(position(row, [304., 400.], [1200., 800.]), [252., 330.]);
        assert_eq!(
            position(Rect { top: 700., ..row }, [304., 400.], [1200., 800.]),
            [252., 388.]
        );
        assert_eq!(
            position(Rect { left: 950., ..row }, [304., 400.], [1200., 800.]),
            [636., 330.]
        );
        assert_eq!(
            position(row, [304., 200.], [550., 800.]),
            [10_f32.max(12.), 370.]
        );
        assert_eq!(
            position(Rect { top: 650., ..row }, [304., 200.], [550., 800.]),
            [12., 440.]
        );
        assert_eq!(position(row, [304., 520.], [300., 500.]), [12., 12.]);
    }
}
