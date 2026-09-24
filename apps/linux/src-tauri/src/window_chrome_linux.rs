//! WebKit consumes edge presses before GTK's bubbling window handlers. Capture
//! them on the native window so dashboard and child browser views stay resizable.
use gtk::prelude::*;

pub fn install(window: &tauri::Window) -> Result<(), tauri::Error> {
    let target = window.clone();
    window.run_on_main_thread(move || {
        let Ok(window) = target.gtk_window() else {
            return;
        };
        let gesture = gtk::GestureMultiPress::new(&window);
        gesture.set_button(1);
        gesture.set_propagation_phase(gtk::PropagationPhase::Capture);
        let weak_window = window.downgrade();
        gesture.connect_pressed(move |gesture, _, x, y| {
            let Some(window) = weak_window.upgrade() else {
                return;
            };
            if window.is_decorated() || !window.is_resizable() || window.is_maximized() {
                return;
            }
            if window
                .window()
                .is_some_and(|surface| surface.state().contains(gtk::gdk::WindowState::FULLSCREEN))
            {
                return;
            }
            let Some(edge) = resize_edge(x, y, window.allocated_width(), window.allocated_height())
            else {
                return;
            };
            let Some(event) = gtk::current_event() else {
                return;
            };
            let Some((root_x, root_y)) = event.root_coords() else {
                return;
            };
            gesture.set_state(gtk::EventSequenceState::Claimed);
            window.begin_resize_drag(edge, 1, root_x as i32, root_y as i32, event.time());
        });
        // GTK 3 weakly stores controllers. This window-owned handler retains
        // ours; both the controller's widget link and its callback are weak.
        window.connect_destroy(move |_| gesture.reset());
    })
}

fn resize_edge(x: f64, y: f64, width: i32, height: i32) -> Option<gtk::gdk::WindowEdge> {
    use gtk::gdk::WindowEdge;

    // Gesture coordinates are logical pixels, including on scaled displays.
    let left = x < 5.0;
    let right = x >= f64::from(width) - 5.0;
    let top = y < 5.0;
    let bottom = y >= f64::from(height) - 5.0;
    match (left, right, top, bottom) {
        (true, _, true, _) => Some(WindowEdge::NorthWest),
        (_, true, true, _) => Some(WindowEdge::NorthEast),
        (true, _, _, true) => Some(WindowEdge::SouthWest),
        (_, true, _, true) => Some(WindowEdge::SouthEast),
        (true, _, _, _) => Some(WindowEdge::West),
        (_, true, _, _) => Some(WindowEdge::East),
        (_, _, true, _) => Some(WindowEdge::North),
        (_, _, _, true) => Some(WindowEdge::South),
        _ => None,
    }
}
