# ERP Database Schema Reference (htjx2021)

Database: SQL Server @ 192.168.3.250, database htjx2021
Total tables: 810

## Key Tables

### eba

address nvarchar(200), agent_id nvarchar(8), allow_login char(1), approve_grade nvarchar(8), background_notes nvarchar(200), bank_account nvarchar(40), bank_account_name nvarchar(80), bank_name nvarchar(100), city_id nvarchar(20), company_kind nvarchar(8), company_size nvarchar(8), country_id nvarchar(20), create_date nvarchar(8), create_user_id nvarchar(16), credit_grade nvarchar(8), dept nvarchar(30), dept_id nvarchar(8), dept_post nvarchar(30), e_mail nvarchar(100), easy_code nvarchar(20), eba_from nvarchar(8), eba_grade nvarchar(8), eba_id nvarchar(16), eba_name nvarchar(100), eba_rela nvarchar(8), eba_type nvarchar(3), emp_id nvarchar(16), employee_eduaction nvarchar(8), fax_no nvarchar(100), gender char(1), home_no nvarchar(100), homepage nvarchar(128), id_code nvarchar(40), id_type nvarchar(8), industry_code nvarchar(8), last_modi_date nvarchar(8), last_modi_user_id nvarchar(16), last_sell_date nvarchar(8), last_touch_date nvarchar(8), last_touch_emp_id nvarchar(16), linkman nvarchar(100), loyalty_grade nvarchar(8), manager_man nvarchar(100), mio_method_id char(1), mobile_no nvarchar(100), msn_no nvarchar(50), note_info ntext, office_no nvarchar(100), order_id int, other_im_no nvarchar(50), owe_amount_limit decimal, owe_time_limit int, parent_eba_id nvarchar(8), post_code nvarchar(8), pre_in decimal, price_group_id nvarchar(100), province_id nvarchar(20), pwd nvarchar(20), qq_no nvarchar(50), revenue_no nvarchar(40), role_id nvarchar(20), sell_duration int, service_id nvarchar(20), should_in decimal, state nvarchar(8), super_manager nvarchar(100), tot_sell_amount decimal, touch_duration int, year_earn nvarchar(8), zone_id nvarchar(20), mio_account nvarchar(3), money_type nvarchar(8), ext_1 nvarchar(80), ext_2 nvarchar(80), ext_3 nvarchar(80), ext_4 nvarchar(80), ext_5 nvarchar(80), ext_6 nvarchar(80), ext_7 nvarchar(80), ext_8 nvarchar(80)

### eba_io

ass_num decimal, batch_no nvarchar(30), cost_price decimal, create_date nvarchar(8), create_user_id nvarchar(16), dept_id nvarchar(8), discount decimal, discount_amount decimal, discount_price decimal, draw_percent decimal, eba_id nvarchar(16), edt_id nvarchar(8), emp_id nvarchar(16), inp_amount decimal, inp_num decimal, inp_num_factor nvarchar(14), inp_price decimal, inp_unit_type_id nvarchar(8), item_fee_1 decimal, item_fee_2 decimal, item_id int, mem_card_no nvarchar(20), money_factor decimal, money_type nvarchar(8), note_info ntext, produce_date nvarchar(8), profit decimal, project_id nvarchar(20), res_id nvarchar(30), ret_flag char(1), std_num decimal, std_unit_type_id nvarchar(8), sub_attr_val_1 nvarchar(30), sub_attr_val_2 nvarchar(30), sub_attr_val_3 nvarchar(30), tax_amount decimal, tax_price decimal, tax_rate decimal, total_amount decimal, v_discount decimal, voucher_date nvarchar(14), voucher_id int, voucher_no nvarchar(30), voucher_type nvarchar(3), vr_item_ext_1 nvarchar(160), vr_item_ext_2 nvarchar(160), vr_item_ext_3 nvarchar(160), vr_item_ext_4 nvarchar(160), vr_item_ext_5 nvarchar(160), vr_item_ext_6 nvarchar(160)

### eba_card

address nvarchar(200), avocation nvarchar(30), birthday nvarchar(8), card_degree nvarchar(8), card_id int, college nvarchar(60), create_date nvarchar(8), create_user_id nvarchar(16), culture_degree nvarchar(8), dept nvarchar(30), dept_post nvarchar(30), e_mail nvarchar(100), easy_code nvarchar(20), eba_id nvarchar(16), fax_no nvarchar(100), gender char(1), home_no nvarchar(100), homepage nvarchar(128), marriage_flag char(1), mobile_no nvarchar(100), msn_no nvarchar(50), name nvarchar(100), nationality nvarchar(8), note_info ntext, office_no nvarchar(100), other_im_no nvarchar(50), post_code nvarchar(8), qq_no nvarchar(50), service_id nvarchar(20), state char(1), ext_1 nvarchar(80), ext_2 nvarchar(80), ext_3 nvarchar(80), ext_4 nvarchar(80), ext_5 nvarchar(80), ext_6 nvarchar(80), ext_7 nvarchar(80), ext_8 nvarchar(80)

### eba_contract

amount decimal, beg_date nvarchar(8), contract_no nvarchar(20), contract_type nvarchar(8), create_date nvarchar(8), create_user_id nvarchar(16), eba_id nvarchar(16), emp_id nvarchar(16), end_date nvarchar(8), ext_1 nvarchar(80), ext_2 nvarchar(80), ext_3 nvarchar(80), ext_4 nvarchar(80), ext_5 nvarchar(80), ext_6 nvarchar(80), ext_7 nvarchar(80), ext_8 nvarchar(80), note_info nvarchar(250), sign_date nvarchar(8), state nvarchar(8), stop_cause nvarchar(80), stop_date nvarchar(8), title nvarchar(80)

### eba_group

create_user_id nvarchar(16), group_id int, group_name nvarchar(40), note_info nvarchar(80), order_id int

### eba_group_member

eba_id nvarchar(16), group_id int

### sup

address nvarchar(200), agent_id nvarchar(8), approve_grade nvarchar(8), background_notes nvarchar(200), bank_account nvarchar(40), bank_account_name nvarchar(80), bank_name nvarchar(100), city_id nvarchar(20), company_kind nvarchar(8), company_size nvarchar(8), country_id nvarchar(20), create_date nvarchar(8), create_user_id nvarchar(16), credit_grade nvarchar(8), dept_id nvarchar(8), e_mail nvarchar(100), easy_code nvarchar(20), emp_id nvarchar(16), employee_eduaction nvarchar(8), fax_no nvarchar(100), home_no nvarchar(100), homepage nvarchar(128), id_code nvarchar(40), id_type nvarchar(8), industry_code nvarchar(8), last_modi_date nvarchar(8), last_modi_user_id nvarchar(16), linkman nvarchar(100), loyalty_grade nvarchar(8), manager_man nvarchar(100), mio_method_id char(1), mobile_no nvarchar(100), msn_no nvarchar(50), note_info ntext, office_no nvarchar(100), order_id int, other_im_no nvarchar(50), owe_amount_limit int, owe_time_limit int, parent_sup_id nvarchar(8), post_code nvarchar(8), pre_out decimal, province_id nvarchar(20), qq_no nvarchar(50), revenue_no nvarchar(40), service_id nvarchar(20), should_out decimal, state nvarchar(8), sup_from nvarchar(8), sup_grade nvarchar(8), sup_id nvarchar(16), sup_name nvarchar(100), sup_rela nvarchar(8), sup_type nvarchar(3), super_manager nvarchar(100), tot_buy_amount decimal, year_earn nvarchar(8), zone_id nvarchar(20), mio_account nvarchar(3), money_type nvarchar(8)

### sup_io

ass_num decimal, batch_no nvarchar(30), create_date nvarchar(8), create_user_id nvarchar(16), dept_id nvarchar(8), discount decimal, discount_amount decimal, discount_price decimal, edt_id nvarchar(8), emp_id nvarchar(16), inp_amount decimal, inp_num decimal, inp_num_factor nvarchar(14), inp_price decimal, inp_unit_type_id nvarchar(8), item_fee_1 decimal, item_fee_2 decimal, item_id int, money_factor decimal, money_type nvarchar(8), note_info ntext, produce_date nvarchar(8), project_id nvarchar(20), res_id nvarchar(30), ret_flag char(1), std_num decimal, std_unit_type_id nvarchar(8), sub_attr_val_1 nvarchar(30), sub_attr_val_2 nvarchar(30), sub_attr_val_3 nvarchar(30), sup_id nvarchar(16), tax_amount decimal, tax_price decimal, tax_rate decimal, total_amount decimal, v_discount decimal, voucher_date nvarchar(14), voucher_id int, voucher_no nvarchar(30), voucher_type nvarchar(3)

### sup_card

address nvarchar(200), avocation nvarchar(30), birthday nvarchar(8), card_degree nvarchar(8), card_id int, college nvarchar(30), create_date nvarchar(8), create_user_id nvarchar(16), culture_degree nvarchar(8), dept nvarchar(30), dept_post nvarchar(30), e_mail nvarchar(100), easy_code nvarchar(20), fax_no nvarchar(100), gender char(1), home_no nvarchar(100), homepage nvarchar(128), marriage_flag char(1), mobile_no nvarchar(100), msn_no nvarchar(50), name nvarchar(100), nationality nvarchar(8), note_info ntext, office_no nvarchar(100), other_im_no nvarchar(50), post_code nvarchar(8), qq_no nvarchar(50), service_id nvarchar(20), state char(1), sup_id nvarchar(16)

### sup_contract

amount decimal, beg_date nvarchar(8), contract_no nvarchar(20), contract_type nvarchar(8), create_date nvarchar(8), create_user_id nvarchar(16), emp_id nvarchar(16), end_date nvarchar(8), ext_1 nvarchar(80), ext_2 nvarchar(80), ext_3 nvarchar(80), ext_4 nvarchar(80), ext_5 nvarchar(80), ext_6 nvarchar(80), ext_7 nvarchar(80), ext_8 nvarchar(80), note_info nvarchar(250), sign_date nvarchar(8), state nvarchar(8), stop_cause nvarchar(80), stop_date nvarchar(8), sup_id nvarchar(16), title nvarchar(80)

### sup_group

create_user_id nvarchar(16), group_id int, group_name nvarchar(40), note_info nvarchar(80), order_id int

### sup_group_member

group_id int, sup_id nvarchar(16)

### ebs_v

check_date nvarchar(8), check_time nvarchar(6), check_user_id nvarchar(16), create_date nvarchar(8), create_user_id nvarchar(16), dept_id nvarchar(16), emp_id nvarchar(16), ext_1 nvarchar(80), ext_2 nvarchar(80), ext_3 nvarchar(80), ext_4 nvarchar(80), ext_5 nvarchar(80), ext_6 nvarchar(80), ext_7 nvarchar(80), ext_8 nvarchar(80), note_info ntext, print_times int, state char(1), voucher_date nvarchar(8), voucher_id int, voucher_no nvarchar(30), voucher_sub_type nvarchar(8), voucher_type nvarchar(3)

### ebs_vr

amount decimal, ass_no nvarchar(80), bank_card_pay_amount decimal, date_lmt_ebm nvarchar(8), date_lmt_res nvarchar(8), discount decimal, discount_amount decimal, draw_amount decimal, draw_percent decimal, eba_id nvarchar(16), eba_res_oper_flag char(1), eba_type char(1), ebm_brand_id nvarchar(8), ebm_pre_oper_flag char(1), ebm_should_oper_flag char(1), edt_id nvarchar(8), edt_site_id nvarchar(8), emf_center_id nvarchar(8), emf_process_id nvarchar(8), emf_shop_id nvarchar(8), emf_v_no nvarchar(20), gift_ticket_pay_amount decimal, io_amount decimal, item_res_edt_eba_oper_flag char(1), item_res_edt_flag char(1), item_res_edt_oper_flag char(1), main_res_edt_flag char(1), main_res_edt_oper_flag char(1), mem_card_no nvarchar(20), mem_card_pay_amount decimal, mem_card_support char(1), mio_account nvarchar(8), mio_method_id char(1), mio_oper_flag char(1), mio_subject_id nvarchar(8), money_factor decimal, money_type nvarchar(8), pre_amount decimal, project_id nvarchar(20), ref_type nvarchar(3), should_amount decimal, target_edt_id nvarchar(16), vir_edt_oper_flag char(1), voucher_id int, ebm_eba_id nvarchar(16)

### ebs_vr_item

ass_num decimal, batch_no nvarchar(30), cost_price decimal, discount decimal, discount_amount decimal, discount_price decimal, inp_amount decimal, inp_num decimal, inp_num_factor nvarchar(14), inp_price decimal, inp_unit_type_id nvarchar(8), is_main char(1), item_date_lmt nvarchar(8), item_edt_id nvarchar(16), item_edt_site_id nvarchar(20), item_emf_center_id nvarchar(8), item_emf_process_id nvarchar(8), item_fee_1 decimal, item_fee_2 decimal, item_id int, item_target_edt_id nvarchar(8), main_id int, note_info ntext, produce_date nvarchar(8), ref_item_id int, ref_voucher_id int, ref_voucher_no nvarchar(30), ref_voucher_type nvarchar(3), res_cost_opt char(1), res_id nvarchar(30), state nvarchar(8), std_num decimal, std_unit_type_id nvarchar(8), sub_attr_val_1 nvarchar(30), sub_attr_val_2 nvarchar(30), sub_attr_val_3 nvarchar(30), tag_amount decimal, tag_price decimal, tax_amount decimal, tax_price decimal, tax_rate decimal, total_amount decimal, voucher_id int, vr_item_ext_1 nvarchar(160), vr_item_ext_2 nvarchar(160), vr_item_ext_3 nvarchar(160), vr_item_ext_4 nvarchar(160), vr_item_ext_5 nvarchar(160), vr_item_ext_6 nvarchar(160), bom_id nvarchar(30)

### ebm_mio

account_id nvarchar(3), amount decimal, check_no nvarchar(40), discount decimal, discount_amount decimal, eba_id nvarchar(16), ebm_brand_id nvarchar(8), io_amount decimal, method_id char(1), mio_oper_flag char(1), mio_subject_id nvarchar(16), pre_in decimal, pre_out decimal, voucher_id int, subject_id_fee nvarchar(20), fee_amount decimal

### ebm_mio_item

amount decimal, bill_id int, bill_type nvarchar(8), date_lmt_ebm nvarchar(8), finish_amount decimal, item_id int, note_info nvarchar(200), org_amount decimal, project_id nvarchar(20), voucher_date nvarchar(8), voucher_id int, voucher_no nvarchar(30)

### ebm_bill

amount decimal, bill_id int, bill_type nvarchar(8), date_lmt_ebm nvarchar(8), dept_id nvarchar(8), eba_id nvarchar(16), ebm_brand_id nvarchar(8), emp_id nvarchar(16), finish_amount decimal, note_info nvarchar(200), project_id nvarchar(20), state char(1), voucher_date nvarchar(8), voucher_id int, voucher_no nvarchar(30), voucher_type nvarchar(3)

### ebm_eba

address nvarchar(100), bank_account nvarchar(40), bank_name nvarchar(100), create_date nvarchar(8), credit_grade nvarchar(8), e_mail nvarchar(50), easy_code nvarchar(20), eba_id nvarchar(16), eba_name nvarchar(40), eba_type nvarchar(3), fax_no nvarchar(20), last_modi_date nvarchar(8), linkman nvarchar(20), mobile_no nvarchar(20), office_no nvarchar(20), owe_amount_limit int, owe_time_limit int, post_code nvarchar(8), revenue_no nvarchar(40), state nvarchar(8)

### ebm_io

account_id nvarchar(3), amount decimal, bill_id int, bill_oper_type char(1), bill_type nvarchar(8), create_voucher_date nvarchar(8), create_voucher_no nvarchar(30), date_lmt_ebm nvarchar(8), dept_id nvarchar(8), eba_id nvarchar(16), ebm_brand_id nvarchar(8), emp_id nvarchar(16), item_id int, note_info nvarchar(200), project_id nvarchar(20), state char(1), voucher_date nvarchar(8), voucher_id int, voucher_no nvarchar(30), voucher_type nvarchar(3)

### mio_oper_io

account_id nvarchar(3), amount decimal, ass_no nvarchar(30), check_no nvarchar(40), eba_id nvarchar(16), io_flag char(1), method_id char(1), project_id nvarchar(20), sup_id nvarchar(16), voucher_id int

### mio_oper_io_item

abstract nvarchar(200), amount decimal, item_id int, item_project_id nvarchar(20), subject_id nvarchar(20), voucher_id int

### mio_bank

bank_code nvarchar(8), bank_name nvarchar(60), stop_flag char(1)

### mio_bank_io

abstract nvarchar(80), account_id nvarchar(3), amount int, bank_check_date nvarchar(8), bank_check_flag char(1), bank_check_group_id int, bank_check_user_id nvarchar(16), create_date nvarchar(8), create_user_id nvarchar(16), io_flag char(1), method_id char(1), mio_bank_io_id int, state char(1), voucher_date nvarchar(8), voucher_no nvarchar(30)

### mio_account

account_id nvarchar(3), account_name nvarchar(60), balance decimal, bank_account nvarchar(30), bank_code nvarchar(20), bank_name nvarchar(60), create_date nvarchar(8), create_user_id nvarchar(16), evm_subject_id nvarchar(20), init_balance decimal, is_cash char(1), method_id char(1), money_type nvarchar(8), note_info nvarchar(80), stop_flag char(1)

### mio_account_io

abstract nvarchar(200), account_id nvarchar(3), amount decimal, amount_before_check decimal, ass_no nvarchar(30), create_date nvarchar(8), create_user_id nvarchar(16), dept_id nvarchar(8), eba_id nvarchar(16), emp_id nvarchar(16), io_flag char(1), item_id int, method_id char(1), note_info nvarchar(200), project_id nvarchar(20), state char(1), subject_id nvarchar(20), sup_id nvarchar(16), voucher_date nvarchar(8), voucher_id int, voucher_no nvarchar(30), voucher_type nvarchar(3), check_date char(8), check_user_id nvarchar(16)

### edt_res

ass_num decimal, batch_no nvarchar(30), edt_id nvarchar(8), edt_site_id nvarchar(20), num decimal, produce_date nvarchar(8), res_id nvarchar(30), sub_attr_val_1 nvarchar(30), sub_attr_val_2 nvarchar(30), sub_attr_val_3 nvarchar(30)

### edt_io

ass_corp nvarchar(80), ass_num decimal, batch_no nvarchar(30), cost_amount decimal, cost_price decimal, create_date nvarchar(8), create_user_id nvarchar(16), dept_id nvarchar(8), discount decimal, discount_amount decimal, discount_price decimal, eba_id nvarchar(16), eba_type char(1), edt_id nvarchar(8), edt_site_id nvarchar(20), emf_center_id nvarchar(8), emf_process_id nvarchar(8), emf_shop_id nvarchar(8), emf_v_no nvarchar(20), emp_id nvarchar(16), inp_amount decimal, inp_num decimal, inp_num_factor nvarchar(14), inp_price decimal, inp_unit_type_id nvarchar(8), io_flag char(1), io_type_id nvarchar(3), item_fee_1 decimal, item_fee_2 decimal, item_id int, money_factor decimal, money_type nvarchar(8), move_res_flag char(1), note_info ntext, produce_date nvarchar(8), project_id nvarchar(20), ref_item_id int, ref_voucher_id int, ref_voucher_no nvarchar(30), ref_voucher_type nvarchar(3), related_edt_id nvarchar(16), res_cost_opt char(1), res_id nvarchar(30), std_num decimal, std_unit_type_id nvarchar(8), sub_attr_val_1 nvarchar(30), sub_attr_val_2 nvarchar(30), sub_attr_val_3 nvarchar(30), tag_amount decimal, tag_price decimal, tax_amount decimal, tax_price decimal, tax_rate decimal, total_amount decimal, voucher_date nvarchar(14), voucher_id int, voucher_no nvarchar(30), voucher_sub_type nvarchar(8), voucher_type nvarchar(3)

### edt_site

edt_id nvarchar(8), edt_site_id nvarchar(20), edt_site_name nvarchar(60), edt_site_no nvarchar(20), order_id int, parent_site_id nvarchar(20)

### edt_site_res

edt_site_id nvarchar(20), res_id nvarchar(30)

### res

ass_unit_type nvarchar(8), auto_copy_parent_info char(1), bar_code nvarchar(30), batch_flag char(1), ceil_num decimal, cost_cal_method char(1), cost_price decimal, create_date nvarchar(8), create_user_id nvarchar(16), default_edt_id nvarchar(16), easy_code nvarchar(20), edt_ceil_num decimal, edt_floor_num decimal, edt_io_flag char(1), emf_route_id nvarchar(40), ext_1 nvarchar(80), ext_2 nvarchar(80), ext_3 nvarchar(80), ext_4 nvarchar(80), ext_5 nvarchar(80), ext_6 nvarchar(80), ext_7 nvarchar(80), ext_8 nvarchar(80), floor_num decimal, homepage nvarchar(250), in_ceil_price decimal, in_ref_price decimal, last_modi_date nvarchar(8), last_modi_user_id nvarchar(16), manufacturer nvarchar(80), num_dot_num int, order_id int, out_floor_price decimal, out_ref_price decimal, parent_res_id nvarchar(20), price_dot_num int, quality_days int, res_cat_id nvarchar(20), res_desc nvarchar(250), res_id nvarchar(30), res_kind nvarchar(8), res_model nvarchar(160), res_name nvarchar(160), res_place nvarchar(40), res_rank nvarchar(20), res_spec nvarchar(200), res_unit_type nvarchar(8), stop_flag char(1), subject_sell_cost nvarchar(20), subject_sell_income nvarchar(20), subject_storage_amount nvarchar(20), sup_id nvarchar(16), uname nvarchar(160), pict_file_id int

### res_catalog

batch_flag char(1), cost_cal_method char(1), default_num_dot_num int, default_price_dot_num int, default_res_kind nvarchar(8), default_unit_type nvarchar(8), edt_io_flag char(1), factor_num_show_mode char(1), note_info nvarchar(120), order_id int, parent_res_cat_id nvarchar(20), res_cat_id nvarchar(20), res_cat_name nvarchar(80), stop_flag char(1), subject_sell_cost nvarchar(20), subject_sell_income nvarchar(20), subject_storage_amount nvarchar(20), default_edt_id nvarchar(16), ext_1 nvarchar(80), ext_2 nvarchar(80), ext_3 nvarchar(80), ext_4 nvarchar(80), ext_5 nvarchar(80), ext_6 nvarchar(80), ext_7 nvarchar(80), ext_8 nvarchar(80)

### res_kind

buy_flag char(1), name nvarchar(80), res_kind nvarchar(8), res_supply_mode char(1), sell_flag char(1)

### emf_shop_order

center_id nvarchar(8), check_num decimal, num decimal, pre_voucher_id int, pre_voucher_no nvarchar(20), req_beg_date nvarchar(8), req_end_date nvarchar(8), res_id nvarchar(20), shop_id nvarchar(8), voucher_id int

### emf_shop_order_item

draw_num decimal, item_id int, note_info nvarchar(80), plan_num decimal, res_id nvarchar(20), use_num decimal, voucher_id int

### emf_task

bad_num decimal, create_date nvarchar(8), create_user_id nvarchar(16), dept_id nvarchar(8), emf_center_id nvarchar(8), emf_process_id nvarchar(8), emf_v_no nvarchar(20), emp_id nvarchar(16), end_date nvarchar(8), end_time nvarchar(6), ext_1 nvarchar(80), ext_2 nvarchar(80), ext_3 nvarchar(80), ext_4 nvarchar(80), ext_5 nvarchar(80), ext_6 nvarchar(80), ext_7 nvarchar(80), ext_8 nvarchar(80), finish_num decimal, issue_date nvarchar(8), issue_time nvarchar(6), note_info ntext, plan_end_date nvarchar(8), plan_end_time nvarchar(6), plan_start_date nvarchar(8), plan_start_time nvarchar(6), res_id nvarchar(20), shop_id nvarchar(8), start_date nvarchar(8), start_time nvarchar(6), state char(1), task_id nvarchar(30), task_num decimal, order_id int, cflag char(1), route_id nvarchar(40), price nvarchar(14), bad_price nvarchar(14)

### emp

avocation nvarchar(30), bank_account nvarchar(40), bank_code nvarchar(8), beg_work_date nvarchar(8), birthday nvarchar(8), birthday_lunar nvarchar(8), college nvarchar(60), contract_beg_date nvarchar(8), contract_end_date nvarchar(8), contract_type nvarchar(8), cross_group_id nvarchar(8), culture_degree nvarchar(8), culture_level nvarchar(8), dept_id nvarchar(16), dept_post nvarchar(16), easy_code nvarchar(20), email nvarchar(50), emp_card_no nvarchar(30), emp_id nvarchar(16), emp_wage_type nvarchar(8), employ_from nvarchar(8), employ_type nvarchar(8), endowment_account nvarchar(80), ext_1 nvarchar(80), ext_2 nvarchar(80), ext_3 nvarchar(80), ext_4 nvarchar(80), ext_5 nvarchar(80), ext_6 nvarchar(80), ext_7 nvarchar(80), ext_8 nvarchar(80), file_location nvarchar(100), graduate_date nvarchar(8), hire_date nvarchar(8), home_address nvarchar(100), home_phone nvarchar(30), housing_account nvarchar(80), leave_cause nvarchar(8), leave_date nvarchar(8), leave_method nvarchar(8), marriage_flag nvarchar(8), medicare_account nvarchar(80), mobile nvarchar(30), msn_no nvarchar(50), name nvarchar(30), nation nvarchar(8), native_place nvarchar(60), note_info ntext, order_id int, other_im_no nvarchar(50), paper_id nvarchar(20), person_web nvarchar(128), polity nvarchar(8), post_date nvarchar(8), post_degree nvarchar(8), practice_beg_date nvarchar(8), practice_end_date nvarchar(8), probation_beg_date nvarchar(8), probation_end_date nvarchar(8), qq_no nvarchar(50), register_location nvarchar(100), related_man nvarchar(30), residence_type nvarchar(8), sex nvarchar(8), specialty nvarchar(60), state nvarchar(8), tax_group_id nvarchar(8), technical nvarchar(8), technical_date nvarchar(8), telephone nvarchar(30), timer_passwd nvarchar(20), unemployment_account nvarchar(80), urgent_telephone nvarchar(30), work_location nvarchar(100), uname nvarchar(60)

### emp_dept

company_id nvarchar(8), dept_id nvarchar(16), dept_kind nvarchar(8), dept_name nvarchar(60), order_id int, parent_dept_id nvarchar(16), std_num int, stop_flag char(1), note_info ntext, uname nvarchar(60)

### emp_post

manager_post_id nvarchar(16), note_info ntext, order_id int, post_degree nvarchar(8), post_id nvarchar(16), post_name nvarchar(60), stop_flag char(1), uname nvarchar(60)

### timer_stat

beg_date nvarchar(8), data_month nvarchar(6), end_date nvarchar(8), title nvarchar(80), voucher_id int

### timer_stat_val

emp_id nvarchar(16), item_code nvarchar(30), item_id int, val decimal, voucher_id int

### wage_set

data_month nvarchar(8), fmt_rep_id nvarchar(60), title nvarchar(80), voucher_id int, wage_set_type nvarchar(8)

### wage_data

data_month nvarchar(8), dept_id nvarchar(16), emp_id nvarchar(16), val decimal, voucher_id int, wage_subject_id nvarchar(8)

### wage_subject

can_edit char(1), dec_num int, is_str char(1), note_info nvarchar(200), order_id int, sms_include char(1), stop_flag nvarchar(8), unit_name nvarchar(8), wage_subject_id nvarchar(8), wage_subject_name nvarchar(30), web_visible char(1)

### evm_v

attachment_num int, mark_id nvarchar(8), mark_no decimal, order_id int, voucher_id int

### evm_v_item

ab_flag char(1), abstract nvarchar(200), amount decimal, ass_dept_id nvarchar(20), ass_eba_id nvarchar(20), ass_emp_id nvarchar(20), ass_num decimal, ass_project_id nvarchar(20), ass_res_id nvarchar(20), ass_sup_id nvarchar(20), item_id int, money_factor decimal, note_info nvarchar(200), org_amount decimal, org_money_type nvarchar(8), subject_id nvarchar(20), voucher_id int

### evm_subject

ab_flag char(1), adjust_rate_flag int, ass_cash_io int, ass_dept_flag int, ass_eba_flag int, ass_emp_flag int, ass_num_flag int, ass_project_flag int, ass_res_flag int, ass_sup_flag int, bind_code nvarchar(30), bind_type char(1), easy_code nvarchar(20), money_type nvarchar(8), name nvarchar(80), res_unit_type nvarchar(20), stop_flag char(1), subject_id nvarchar(20), subject_kind nvarchar(8)

### evm_io

ab_flag char(1), abstract nvarchar(200), amount decimal, ass_dept_id nvarchar(20), ass_eba_id nvarchar(20), ass_emp_id nvarchar(20), ass_num decimal, ass_project_id nvarchar(20), ass_res_id nvarchar(20), ass_sup_id nvarchar(20), cycle_id nvarchar(6), item_id int, mark_id nvarchar(8), mark_no decimal, money_factor decimal, note_info nvarchar(200), opposite_subject nvarchar(80), org_amount decimal, org_money_type nvarchar(8), subject_id nvarchar(20), voucher_date nvarchar(8), voucher_id int, voucher_no nvarchar(30), voucher_type nvarchar(3)

### app_company

company_id nvarchar(8), company_name nvarchar(80), note_info ntext, order_id int, uname nvarchar(80)

### app_dept

company_id nvarchar(8), dept_id nvarchar(16), dept_name nvarchar(60), order_id int, parent_dept_id nvarchar(16), stop_flag char(1), uname nvarchar(60)

### app_emp

dept_id nvarchar(16), easy_code nvarchar(20), email nvarchar(50), emp_id nvarchar(16), mobile nvarchar(30), msn_no nvarchar(50), name nvarchar(30), order_id int, other_im_no nvarchar(50), post_id nvarchar(16), qq_no nvarchar(50), stop_flag char(1), telephone nvarchar(30)

### app_dict

code_max_len int, color_flag char(1), dict_class_id nvarchar(30), dict_id nvarchar(30), is_user_define char(1), note_info nvarchar(80)

### app_dict_def

code nvarchar(80), color_val int, dict_id nvarchar(30), is_group char(1), name nvarchar(80), note_info nvarchar(120), order_id int, stop_flag char(1)

### app_voucher_type

allow_create_check_same_user char(1), check_mode char(1), head_mask nvarchar(60), id_len int, is_vr char(1), must_check_before_print char(1), note_info_line_num int, oa_request_type nvarchar(8), obj_id nvarchar(30), order_id int, sep_char char(1), show_sub_type char(1), stop_flag char(1), time_mask nvarchar(12), voucher_group_id nvarchar(8), voucher_name nvarchar(30), voucher_type nvarchar(3)

### app_voucher_sub_type

name nvarchar(30), voucher_sub_type nvarchar(8), voucher_type nvarchar(3), stop_flag char(1)

### mup_user

ask_chg_pwd char(1), can_chg_pwd char(1), create_user_id nvarchar(16), emp_id nvarchar(16), frame_can_choose char(1), frame_id nvarchar(20), is_admin char(1), note_info nvarchar(100), pwd nvarchar(32), state char(1), unit_id nvarchar(8), user_id nvarchar(16), user_name nvarchar(60)

### mup_role

role_id nvarchar(20), role_name nvarchar(30), role_note nvarchar(200)

## Voucher Types

- **XA**: 初始化 (vir)
- **VA**: 会计凭证 (evm)
- **QA**: 质量检查 (qm)
- **VB**: 调汇凭证 (evm)
- **XB**: 手工录入 (vir)
- **QB**: 自定义质检QB (qm)
- **QC**: 自定义质检QC (qm)
- **VC**: 结转凭证 (evm)
- **VX**: 初始化 (vir)
- **QD**: 自定义质检QD (qm)
- **QE**: 自定义质检QE (qm)
- **QF**: 自定义质检QF (qm)
- **QG**: 自定义质检QG (qm)
- **QH**: 自定义质检QH (qm)
- **HA**: 生产计划单 (emf)
- **GA**: 其他入库单 (edt)
- **GB**: 其他出库单 (edt)
- **HB**: 加工单 (emf)
- **HC**: 产成单 (emf)
- **GC**: 盘点单 (edt)
- **GD**: 移库单 (edt)
- **HD**: 生产领料单 (emf)
- **HE**: 生产退料单 (emf)
- **GE**: 组装单 (edt)
- **GF**: 拆卸单 (edt)
- **HF**: 自定义单据HF (emf)
- **HG**: 自定义单据HG (emf)
- **GG**: 报废出库单 (edt)
- **GH**: 自定义单据GH (edt)
- **HH**: 自定义单据HH (emf)
- **HI**: 自定义单据HI (emf)
- **GI**: 自定义单据GI (edt)
- **GJ**: 自定义单据GJ (edt)
- **HJ**: 生产领料关闭 (emf)
- **HK**: 产成入库单 (emf)
- **GK**: 自定义单据GK (edt)
- **GL**: 自定义单据GL (edt)
- **HL**: 产成退库单 (emf)
- **HM**: 产成关闭单 (emf)
- **GM**: 自定义单据GM (edt)
- **GN**: 自定义单据GN (edt)
- **HN**: 自定义单据HN (emf)
- **HO**: 外协加工单 (emf)
- **GO**: 自定义单据GO (edt)
- **HP**: 外协产成单 (emf)
- **GP**: 派车单 (edt)
- **HQ**: 外协领料单 (emf)
- **GQ**: 自定义单据GQ (edt)
- **GR**: 自定义单据GR (edt)
- **HR**: 外协退料单 (emf)
- **HS**: 外协领料关闭 (emf)
- **GS**: 补货计划单 (edt)
- **HT**: 外协产成关闭单 (emf)
- **GT**: 库存调价单 (edt)
- **HU**: 自定义单据HU (emf)
- **GU**: 自定义单据GU (edt)
- **GV**: 自定义单据GV (edt)
- **HV**: 外协产成退库单 (emf)
- **HW**: 自定义单据HW (emf)
- **GW**: 自定义单据GW (edt)
- **GX**: 初始化 (vir)
- **JA**: 生产计划关闭单 (emf)
- **GY**: 手工录入 (vir)
- **JB**: 工序外协入库单 (emf)
- **JC**: 工序外协关闭单 (emf)
- **GZ**: 需求计算单 (edt)
- **JD**: 工序外协出库单 (emf)
- **GZK**: 需求计算单增量 (vir)
- **GZL**: 需求计算单减量 (vir)
- **JE**: 自定义单据JE (emf)
- **JF**: 自定义单据JF (emf)
- **LA**: 员工借用 (edt)
- **LB**: 员工归还 (edt)
- **JG**: 自定义单据JG (emf)
- **LE**: 包装物料出厂单 (edt)
- **JH**: BOM成本核验单 (emf)
- **JI**: 自定义单据JI (emf)
- **LF**: 包装物料入厂单 (edt)
- **LG**: 需求附加计划 (edt)
- **JJ**: 自定义单据JJ (emf)
- **MA**: 转制单 (emf)
- **LR**: 自定义单据LR (edt)
- **LS**: 自定义单据LS (edt)
- **MB**: 交接单 (emf)
- **MC**: 生产任务单 (emf)
- **LT**: 自定义单据LT (edt)
- **LU**: 自定义单据LU (edt)
- **MD**: 生产计算单 (emf)
- **LV**: 自定义单据LV (edt)
- **LW**: 自定义单据LW (edt)
- **LX**: 入库调价单 (edt)
- **LY**: 成本修正单 (edt)
- **BA**: 销售订单 (eba)
- **BB**: 销售发货单 (eba)
- **BC**: 销售开票 (eba)
- **BE**: 现款销售 (eba)
- **BF**: 销售退货单 (eba)
- **BG**: 销售报价单 (eba)
- **BH**: Pos销售 (eba)
- **BX**: 销售初始化 (vir)
- **BY**: 会员卡充值 (vir)
- **BZ**: 会员卡退款 (vir)
- **BI**: 自定义单据BI (eba)
- **BJ**: 发货计划单 (eba)
- **BK**: 销售对账单 (eba)
- **BL**: 销售开票关闭 (eba)
- **BM**: 销售关闭单 (eba)
- **BS**: 展期续费单 (eba)
- **BN**: 自定义单据BN (eba)
- **BO**: 自定义单据BO (eba)
- **BP**: 自定义单据BP (eba)
- **BQ**: 自定义单据BQ (eba)
- **BR**: 自定义单据BR (eba)
- **BT**: 自定义单据BT (eba)
- **BU**: 自定义单据BU (eba)
- **BV**: 自定义单据BV (eba)
- **AA**: 采购订单 (sup)
- **AB**: 采购入库单 (sup)
- **AC**: 采购开票 (sup)
- **AD**: 采购计划单 (sup)
- **AE**: 现款采购 (sup)
- **AF**: 采购退货单 (sup)
- **AG**: 采购询价单 (sup)
- **AH**: 采购申请单 (sup)
- **AX**: 采购初始化 (vir)
- **AI**: 采购关闭单 (sup)
- **AJ**: 自定义单据AJ (sup)
- **AK**: 自定义单据AK (sup)
- **AL**: 采购预付款单 (sup)
- **AN**: 自定义单据AN (sup)
- **AO**: 自定义单据AO (sup)
- **AP**: 自定义单据AP (sup)
- **AQ**: 自定义单据AQ (sup)
- **FA**: 存取款单 (mio)
- **FB**: 其他收款单 (mio)
- **FC**: 其他付款单 (mio)
- **FD**: 员工借款单 (mio)
- **FE**: 员工还款单 (mio)
- **FF**: 部门预算单 (mio)
- **FG**: 项目预算单 (mio)
- **FX**: 账户建立 (vir)
- **FH**: 换汇单 (mio)
- **FI**: 结汇单 (mio)
- **CA**: 预收款单 (ebm)
- **CB**: 收款单 (ebm)
- **CC**: 应收款单 (ebm)
- **CX**: 应收款初试化 (vir)
- **CY**: 预收款初试化 (vir)
- **DA**: 预付款单 (ebm)
- **DB**: 付款单 (ebm)
- **DC**: 应付款单 (ebm)
- **DX**: 应付款初试化 (vir)
- **DY**: 预付款初试化 (vir)
- **EA**: 应收核销 (ebm)
- **EB**: 应付核销 (ebm)
- **IA**: 工资单 (wage)
- **IC**: 计件工资单 (wage)
- **IB**: 保险支付月账 (emp)
- **YA**: 考勤月账 (timer)
- **YB**: 加班申请单据 (timer)
- **YC**: 补打卡申请单据 (timer)

## All Tables by Module Prefix

**addr** (4): addr_city, addr_country, addr_province, addr_zone
**app** (60): app_attr_def, app_card_fmt, app_card_fmt_def, app_card_fmt_user, app_clear_log_log, app_clear_log_para, app_company, app_dept, app_dict, app_dict_def, app_dict_def_old, app_dict_sql, app_dict_tmp_key_set, app_emp, app_emp_group, app_emp_group_member, app_fee, app_fs, app_fs_file, app_gen_batch_no_ext, app_gen_batch_no_rule, app_gen_id_ext, app_gen_id_rule, app_grid_fmt, app_grid_fmt_def, app_grid_fmt_role, app_grid_fmt_user, app_group, app_group_item, app_instruct, app_lmt_def_item, app_loadfmt_profile, app_my_remind, app_my_voucher, app_not_null_def, app_note, app_obj_ext_def, app_obj_source, app_obj_source_list, app_obj_source_type, app_para, app_remind_def, app_sequence, app_server_task, app_server_task_type, app_sql_cond, app_sql_cond_item, app_tmp_key_set, app_tree_code_map, app_user_tab, app_user_tab_col, app_voucher_checked_modi, app_voucher_date_lmt, app_voucher_evm_para, app_voucher_source, app_voucher_sub_type, app_voucher_type, app_win_label, app_win_source, app_wx_map
**asset** (28): asset, asset_acc, asset_acc_depre, asset_acc_init, asset_acc_io, asset_assist, asset_attr, asset_chg, asset_count_no, asset_count_no_num, asset_cycle, asset_depre, asset_dept_apart, asset_desc, asset_draw, asset_examine, asset_ext_def, asset_file, asset_file_data, asset_group, asset_group_item, asset_hire, asset_load, asset_move, asset_stat, asset_stat_ass, asset_type, asset_vender
**bbs** (25): bbs_ad_list, bbs_board, bbs_detail, bbs_detail_ext, bbs_detail_file, bbs_group, bbs_group_subject, bbs_login_log, bbs_manager, bbs_page, bbs_page_link, bbs_para, bbs_search, bbs_search_topic, bbs_subject, bbs_subject_stat, bbs_top_topic, bbs_topic, bbs_topic_key_word, bbs_user, bbs_user_favorite, bbs_user_photo, bbs_user_photo_catalog, bbs_user_subject, bbs_user_topic
**car** (5): car_card, car_crime, car_fee, car_repair, car_use
**crm** (32): crm_card, crm_card_group, crm_card_group_member, crm_card_note, crm_chance, crm_chance_item, crm_chance_note, crm_chance_touch, crm_clew, crm_clew_group, crm_clew_note, crm_clew_touch, crm_cost, crm_cost_def, crm_cost_item, crm_event, crm_event_deal, crm_event_note, crm_fee, crm_group, crm_group_attr, crm_group_linkman, crm_group_linkman_member, crm_group_member, crm_qq_group, crm_repair, crm_repair_item, crm_taste, crm_taste_note, crm_taste_plan, crm_touch, crm_web_site
**eas** (17): eas_add_up, eas_assess_grade, eas_assess_group, eas_assess_group_line, eas_cal_set, eas_cal_set_line, eas_def_class, eas_def_item, eas_def_item_cause, eas_g_detail, eas_g_item, eas_item_grade, eas_set, eas_set_cal, eas_set_class, eas_set_emp, eas_set_item
**eba** (34): eba, eba_attr, eba_bill_init, eba_bill_init_imp_tmp, eba_card, eba_card_note, eba_contract, eba_contract_desc, eba_expire, eba_expire_remind, eba_expire_v, eba_group, eba_group_member, eba_group_share, eba_imp_tmp, eba_io, eba_io_init, eba_io_t, eba_mem_card, eba_mem_card_acc, eba_mem_card_ex_rule, eba_mem_card_para, eba_mem_card_usage, eba_note, eba_pos, eba_pos_login_log, eba_pre_init, eba_price, eba_price_group, eba_price_res_cat, eba_price_sub_group, eba_request, eba_service, eba_vr
**ebm** (6): ebm_bill, ebm_brand, ebm_eba, ebm_io, ebm_mio, ebm_mio_item
**ebs** (34): ebs_def_vr, ebs_def_vr_ref_para, ebs_ref, ebs_v, ebs_v_attr, ebs_v_attr_t, ebs_v_item_attr, ebs_v_item_attr_t, ebs_v_log, ebs_v_note, ebs_v_note_t, ebs_v_oper_log, ebs_v_print, ebs_v_res_cost_io, ebs_v_t, ebs_voucher_id_t, ebs_voucher_ref_def, ebs_voucher_type_def, ebs_vr, ebs_vr_batch_attr, ebs_vr_ctl, ebs_vr_ext_voucher_type, ebs_vr_item, ebs_vr_item_attr, ebs_vr_item_attr_t, ebs_vr_item_ref_tmp_all, ebs_vr_item_ref_tmp_one, ebs_vr_item_set, ebs_vr_item_t, ebs_vr_lb, ebs_vr_lb_oper_log, ebs_vr_ref_finish, ebs_vr_ref_set, ebs_vr_t
**edoc** (6): edoc_catalog, edoc_catalog_priv, edoc_doc, edoc_group, edoc_group_admin, edoc_group_user
**edt** (35): edt, edt_cost_price_v, edt_cycle, edt_cycle_cost_price, edt_cycle_res, edt_cycle_res_cost_tmp, edt_eba_io, edt_eba_res, edt_io, edt_io_adjust, edt_io_t, edt_io_type, edt_io_vir, edt_lb_e, edt_plan, edt_plan_res, edt_plan_res_set, edt_plan_res_set_item, edt_plan_res_set_ref_item, edt_plan_res_set_type, edt_ref_cost_price, edt_ref_def, edt_res, edt_res_batch_price, edt_res_cost, edt_res_cost_edt_io_tmp, edt_res_cost_price, edt_res_cost_req, edt_res_cost_usage, edt_res_init, edt_res_vir, edt_res_warn_set, edt_site, edt_site_res, edt_vir
**ekg** (10): ekg, ekg_catalog, ekg_catalog_priv, ekg_catalog3, ekg_doc, ekg_doc_text, ekg_group, ekg_group_admin, ekg_group_user, ekg_node
**emf** (31): emf_center, emf_check_order, emf_check_order_cost, emf_check_order_item, emf_cost_def, emf_cost_order, emf_cost_order_item, emf_cost_order_item_fee, emf_draw_io_item, emf_draw_order, emf_io, emf_lsw, emf_lsw_io, emf_lsw_res, emf_main_plan, emf_process, emf_process_dir, emf_res_catalog, emf_res_def, emf_res_io, emf_res_io_type, emf_res_num, emf_res_sup, emf_route, emf_route_dir, emf_route_process, emf_shop, emf_shop_order, emf_shop_order_item, emf_task, emf_task_attr
**emp** (57): emp, emp_attr, emp_black_id, emp_card, emp_card_keep_his, emp_card_type, emp_company, emp_company_user, emp_contract, emp_contract_attr, emp_contract_temp, emp_contract_temp_data, emp_contract_type, emp_dept, emp_dept_post, emp_desc, emp_dorm, emp_dorm_fee, emp_dorm_fee_apart, emp_dorm_member, emp_dorm_use, emp_ext_def, emp_family, emp_group, emp_group_member, emp_imp_tmp, emp_insurance, emp_insurance_payment, emp_insurance_type, emp_insurance_v, emp_insurance_v_emp, emp_insurance_v_item, emp_job_hurt, emp_leave_chat, emp_med_check, emp_note, emp_notice, emp_part_time, emp_pict, emp_pict_data, emp_post, emp_post_move, emp_prize, emp_punishment, emp_res_catalog, emp_res_def, emp_res_draw, emp_res_io, emp_res_io_type, emp_res_num, emp_res_sup, emp_study_his, emp_technical, emp_train, emp_welfare, emp_welfare_type, emp_work_his
**eqs** (14): eqs, eqs_answer, eqs_answer_choose, eqs_answer_desc, eqs_answer_mark, eqs_def_class, eqs_def_item, eqs_def_item_choice, eqs_group, eqs_item, eqs_item_choice, eqs_predef_choice, eqs_predef_choice_item, eqs_type
**evm** (34): evm_abstract, evm_account, evm_account_f, evm_account_sep, evm_account_sep_cycle, evm_account_sep_cycle_f, evm_account_sep_f, evm_cash_io, evm_cash_io_init, evm_cash_subject, evm_cash_subject_map, evm_cycle, evm_cycle_open, evm_cycle_open_f, evm_def_trans, evm_def_trans_item, evm_group, evm_group_item, evm_imp_lst, evm_imp_rule, evm_imp_rule_item, evm_imp_rule_source, evm_init, evm_io, evm_io_f, evm_money_type, evm_subject, evm_subject_imp_tmp, evm_v, evm_v_cash_io, evm_v_item, evm_v_money_rate, evm_v_temp, evm_v_temp_item
**hrm** (23): hrm_black, hrm_emp_skill, hrm_employ_person, hrm_employ_person_desc, hrm_employ_plan, hrm_employ_plan_dept, hrm_employ_plan_detail, hrm_employ_plan2, hrm_employ_process_info, hrm_fee, hrm_file_trust, hrm_file_trust_fee, hrm_grow_plan, hrm_grow_plan_group, hrm_grow_plan_trace, hrm_post, hrm_post_info, hrm_post_skill, hrm_salary_grade, hrm_skill, hrm_skill_group, hrm_skill_person, hrm_skill_person_trace
**mio** (31): mio_account, mio_account_io, mio_bank, mio_bank_io, mio_bank_io_check, mio_budget_subject, mio_budget_type, mio_budget_v, mio_budget_v_obj, mio_budget_v_subject, mio_budget_v_val, mio_change, mio_check, mio_check_buy, mio_check_oper, mio_cycle, mio_cycle_account, mio_emp_loan_log2, mio_emp_loan11, mio_evm_io, mio_expense, mio_expense_item, mio_loan, mio_loan_ret, mio_method, mio_move, mio_oper_io, mio_oper_io_item, mio_subject, mio_v_loan, mio_v_loan_ret
**mup** (56): mup_action, mup_bo, mup_dll, mup_frame, mup_frame_menu, mup_frame_nag, mup_func_set, mup_func_set_item, mup_group, mup_group_member, mup_lic, mup_lic_online, mup_lic_para, mup_licence, mup_licence_ext, mup_login_log, mup_m_ext, mup_m_nag, mup_machine_para, mup_menu_group, mup_menu_group_item, mup_menu_set, mup_menu_set_item, mup_modu, mup_modu_obj, mup_modu_obj_action, mup_msg, mup_msg_obj, mup_nag_group, mup_nag_group_item, mup_obj, mup_obj_log, mup_obj_priv, mup_priv_obj, mup_priv_obj_limit, mup_role, mup_role_priv, mup_shortcut, mup_single_login, mup_sys, mup_sys_func, mup_sys_func_activate, mup_unit, mup_user, mup_user_attr, mup_user_bo, mup_user_frame, mup_user_limit, mup_user_limit_val, mup_user_nag_group, mup_user_nag_group_item, mup_user_para, mup_user_rela, mup_user_role, mup_wo, mup_wo_item
**oa** (23): oa_daily, oa_favorite_sentence, oa_news, oa_news_txt, oa_plan, oa_request, oa_request_car_use, oa_request_checker, oa_request_def, oa_request_def_flow, oa_request_desc, oa_request_desc_check, oa_request_errand, oa_request_exp, oa_request_flow, oa_request_flow_temp, oa_request_leave, oa_seal_use, oa_sign_def, oa_sign_rec, oa_task, oa_tool_def, oa_user_tool
**pm** (4): pm_project, pm_project_attr, pm_project_note, pm_project_type
**qm** (11): qm_catalog, qm_degree_std, qm_group, qm_group_item, qm_item, qm_item_list, qm_list, qm_obj_grp, qm_v, qm_v_data, qm_v_item
**rep** (25): rep, rep_analysis, rep_analysis_item, rep_analysis_source, rep_analysis_source_item, rep_attr, rep_board, rep_board_unit, rep_catalog, rep_chart, rep_chart_exp, rep_chart_para, rep_chart_sort, rep_ds, rep_ds_source, rep_flow, rep_flow_unit, rep_form, rep_form_unit, rep_group, rep_my_rep, rep_obj_key_map, rep_source, rep_unit, rep_user
**res** (22): res, res_attr, res_bom, res_bom_item, res_bom_type, res_catalog, res_composing, res_cost_io, res_default_unit_type, res_desc, res_eba_code_map, res_eba_code_map_imp_tmp, res_group, res_group_item, res_imp_tmp, res_kind, res_provide_info, res_replace_def, res_std_attr, res_sub_attr_def, res_sub_attr_price, res_unit_type_ext
**rival** (7): rival, rival_desc, rival_note, rival_res, rival_res_cmp, rival_res_desc, rival_res_note
**sup** (22): sup, sup_attr, sup_bill_init, sup_bill_init_imp_tmp, sup_card, sup_card_note, sup_contract, sup_contract_desc, sup_group, sup_group_linkman, sup_group_linkman_member, sup_group_member, sup_imp_tmp, sup_io, sup_io_init, sup_io_t, sup_linkman, sup_linkman_note, sup_note, sup_pre_init, sup_price_info, sup_service
**taobao** (2): taobao_app, taobao_shop
**tbx** (49): tbx_call_record, tbx_card, tbx_card_group, tbx_card_group_member, tbx_card_group_share, tbx_card_note, tbx_chat, tbx_daily, tbx_daily_obj, tbx_daily_type, tbx_favorite_sentence, tbx_file_transfer, tbx_inform, tbx_inform_reader, tbx_inspect_class, tbx_inspect_def, tbx_inspect_log, tbx_mail, tbx_mail_account, tbx_mail_attachment, tbx_mail_catalog, tbx_mail_temp, tbx_meet, tbx_meet_member, tbx_meet_msg, tbx_memory, tbx_memory_type, tbx_msg, tbx_msg_obj, tbx_news, tbx_news_txt, tbx_notebook, tbx_notebook_text, tbx_plan, tbx_qq_group, tbx_qq_group_type, tbx_scheme, tbx_shortcut, tbx_sms_list, tbx_sms_log, tbx_sms_temp, tbx_sms_to_send, tbx_smtp_log, tbx_smtp_log_err, tbx_task, tbx_tool_def, tbx_user_tool, tbx_web_site, tbx_web_site_type
**timer** (49): timer_absent, timer_bank_io, timer_cal_set, timer_cal_set_line, timer_card, timer_class_def, timer_class_emp, timer_class_lmt, timer_class_rule, timer_driver, timer_duration, timer_emp_cal, timer_emp_group, timer_emp_group_map, timer_errand, timer_gather, timer_holiday, timer_leave, timer_list, timer_list_temp, timer_mark_v, timer_mark_v_item, timer_meal, timer_meal_type, timer_off_work, timer_original_rec, timer_out, timer_overtime, timer_overtime_type, timer_overtime_v, timer_overtime_v_item, timer_para, timer_part, timer_rec_process_card, timer_rec_process_emp, timer_rec_process_log, timer_rec_process_task, timer_rest, timer_rest_std, timer_rest_std_def, timer_rest_std_rule, timer_result_def, timer_source, timer_source_attr, timer_stat, timer_stat_emp, timer_stat_item_def, timer_stat_val, timer_to_process
**train** (24): train, train_book, train_class, train_class_detail, train_demand, train_demand_emp, train_detail, train_emp, train_emp_record, train_emp_req, train_emp_skip, train_exam, train_fee, train_list, train_plan, train_plan_detail, train_plan_emp, train_plan_fee, train_plan2, train_research, train_service, train_skill, train_source, train_teacher
**ut** (1): ut_emf_center_scheduling
**wage** (29): wage_bank_file_fmt, wage_data, wage_data_str, wage_degree, wage_degree_item, wage_dept, wage_emp, wage_emp_bank, wage_emp_bank_io, wage_group, wage_group_cal, wage_group_item, wage_set, wage_set_cal, wage_set_emp, wage_set_subject, wage_set_type, wage_set_val, wage_set_work, wage_std, wage_std_val, wage_subject, wage_tax, wage_tax_group, wage_work_point, wage_work_price, wage_work_subject, wage_work_v, wage_work_v_item
