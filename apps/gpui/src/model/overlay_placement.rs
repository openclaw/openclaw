//! Horizontal-first overlay placement with a vertical fallback and viewport clamping.
#[derive(Clone, Copy, Debug)]
pub struct Rect {
    pub left: f32,
    pub top: f32,
    pub width: f32,
    pub height: f32,
}

#[derive(Clone, Copy)]
pub struct Placement {
    pub gap: f32,
    pub viewport_padding: f32,
}

pub fn horizontal_first(
    anchor: Rect,
    card: [f32; 2],
    viewport: [f32; 2],
    placement: Placement,
) -> [f32; 2] {
    let gap = placement.gap;
    let padding = placement.viewport_padding;
    let [width, height] = card;
    let [viewport_width, viewport_height] = viewport;
    let max_left = (viewport_width - width - padding).max(padding);
    let max_top = (viewport_height - height - padding).max(padding);
    let right = anchor.left + anchor.width;
    let bottom = anchor.top + anchor.height;
    let fits_below = bottom + gap + height + padding <= viewport_height;
    let fits_right = right + gap + width + padding <= viewport_width;
    let fits_left = anchor.left - gap - width >= padding;
    let fits_above = anchor.top - gap - height >= padding;
    let (left, top) = if fits_right || fits_left || (!fits_below && !fits_above) {
        (
            if fits_right {
                right + gap
            } else {
                anchor.left - width - gap
            },
            anchor.top,
        )
    } else {
        (
            anchor.left,
            if fits_below {
                bottom + gap
            } else {
                anchor.top - height - gap
            },
        )
    };
    [left.clamp(padding, max_left), top.clamp(padding, max_top)]
}

#[cfg(test)]
mod tests {
    use super::*;

    const PLACEMENT: Placement = Placement {
        gap: 10.,
        viewport_padding: 12.,
    };

    fn position(anchor: Rect, card: [f32; 2], viewport: [f32; 2]) -> [f32; 2] {
        horizontal_first(anchor, card, viewport, PLACEMENT)
    }

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
